import { ContextMenu } from './ContextMenu.js';
import { MessageViewerPopup } from './MessageViewerPopup.js';
import { ChatRenameHandler } from './ChatRenameHandler.js';

export class ChatTreeView {
    constructor(dependencies) {
        this.characters = dependencies.characters;
        this.this_chid = dependencies.this_chid;
        this.token = dependencies.token;
        this.openCharacterChat = dependencies.openCharacterChat;
        this.extensionName = dependencies.extensionName;
        this.pluginBaseUrl = dependencies.pluginBaseUrl;

        // State
        this.treeRoots = [];
        this.allTreeRoots = []; // Store all root nodes for dropdown
        this.nodeMap = new Map();
        this.currentChatFile = null;
        this.currentChatUUID = null;
        this.currentRootNode = null; // Track currently selected root
        this.expandedUUIDs = new Set();
        
        // UI State
        this.resizeTimer = null;
        this.isPanning = false;
        this.wasPanning = false; // Track if we just finished panning
        this.panStart = { x: 0, y: 0, scrollX: 0, scrollY: 0 };
        this.isSwappingChat = false; // Prevent multiple simultaneous chat swaps
        this.isRenaming = false; // Track rename state
        this.renameNode = null; // Track node being renamed

        // Sub-components
        this.contextMenu = new ContextMenu();
        this.messageViewerPopup = null;
        this.contextMenuNode = null;
        this.renameHandler = new ChatRenameHandler({
            token: this.token,
            pluginBaseUrl: this.pluginBaseUrl,
            characters: this.characters,
            this_chid: this.this_chid
        });

        this.setupContextMenu();
    }

    setupContextMenu() {
        this.contextMenu.onOptionSelect((optionId) => {
            if (optionId === 'view-messages' && this.contextMenuNode) {
                this.openMessageViewer(this.contextMenuNode);
            } else if (optionId === 'expand-all') {
                this.expandAllNodes();
            } else if (optionId === 'collapse-all') {
                this.collapseAllNodes();
            } else if (optionId === 'find-current') {
                this.centerOnActive();
            }
            this.contextMenuNode = null;
        });
    }

    updateDependencies(dependencies) {
        this.characters = dependencies.characters;
        this.this_chid = dependencies.this_chid;
        this.token = dependencies.token;
        if (dependencies.pluginBaseUrl) {
            this.pluginBaseUrl = dependencies.pluginBaseUrl;
        }
        // Update rename handler dependencies
        this.renameHandler.updateDependencies(dependencies);
    }

    // =========================================================================
    // DATA LOGIC - NOW USING PLUGIN
    // =========================================================================

    async show() {
        if (!this.this_chid && this.this_chid !== 0) {
            toastr.warning('No character selected.');
            return;
        }

        this.currentChatFile = this.characters[this.this_chid]?.chat;
        if (!this.currentChatFile) {
            toastr.info('No active chat found.');
            return;
        }

        // Get current chat UUID from metadata
        this.currentChatUUID = this.characters[this.this_chid]?.chat_metadata?.uuid || null;

        await this.renderModalSkeleton();
        await this.loadAndBuildTree();
    }

    async loadAndBuildTree() {
        this.setLoading(true);

        try {
            // Get character ID for plugin query
            const characterId = this.characters[this.this_chid]?.avatar;
            
            if (!characterId) {
                throw new Error('Character ID not found');
            }

            // Fetch tree from plugin (instant!)
            const treeData = await this.fetchTreeFromPlugin(characterId);
            
            // Build node map and find current chat
            this.buildNodeMapFromTree(treeData);
            
            // Find current chat in the tree
            this.findCurrentNode();
            
            // Isolate only the tree containing current chat
            this.isolateActiveTree();

            // Auto-expand path to current node
            this.expandActivePath();

            // Populate root dropdown
            this.populateRootDropdown();

            // Render
            this.render();
            
            // Center on active node
            this.centerOnActive();

        } catch (err) {
            console.error('[Chat Branches] Error loading tree:', err);
            
            // Fallback to legacy scanning if plugin fails
            if (err.message.includes('fetch') || err.message.includes('404')) {
                console.warn('[Chat Branches] Plugin unavailable, falling back to legacy mode');
                await this.loadAndBuildTreeLegacy();
            } else {
                $('#chat_tree_content').html(`<div class="chat-tree-error">Error: ${err.message}</div>`);
            }
        } finally {
            this.setLoading(false);
        }
    }

    async fetchTreeFromPlugin(characterId) {
        const response = await fetch(`${this.pluginBaseUrl}/tree/${characterId}`, {
            headers: {
                'X-CSRF-Token': this.token
            }
        });

        if (!response.ok) {
            throw new Error(`Plugin request failed: ${response.status}`);
        }

        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error || 'Plugin returned error');
        }

        return data.tree;
    }

    buildNodeMapFromTree(treeArray) {
        this.nodeMap.clear();
        
        // Recursively process tree structure from plugin
        const processNode = (node, parent = null) => {
            // Create our internal node structure
            const internalNode = {
                id: node.uuid,
                name: node.chat_name,
                parentId: node.parent_uuid,
                children: [],
                data: node,
                parent: parent
            };

            this.nodeMap.set(node.uuid, internalNode);

            // Process children
            if (node.children && node.children.length > 0) {
                node.children.forEach(child => {
                    const childNode = processNode(child, internalNode);
                    internalNode.children.push(childNode);
                });
            }

            return internalNode;
        };

        // Process all root nodes
        this.allTreeRoots = treeArray.map(root => processNode(root));
        this.treeRoots = [...this.allTreeRoots]; // Initialize with all roots
    }

    findCurrentNode() {
        this.currentNode = null;

        // First priority: Find by UUID (most reliable, survives renames)
        if (this.currentChatUUID) {
            const nodeByUUID = this.nodeMap.get(this.currentChatUUID);
            if (nodeByUUID) {
                this.currentNode = nodeByUUID;
                console.log('[Chat Branches] Found current node by UUID:', this.currentChatUUID, '->', nodeByUUID.name);
                return;
            } else {
                console.warn('[Chat Branches] UUID not found in tree:', this.currentChatUUID);
            }
        }

        // Fallback: Try to find by exact name match
        for (const [uuid, node] of this.nodeMap) {
            if (node.name === this.currentChatFile) {
                this.currentNode = node;
                console.log('[Chat Branches] Found current node by name match:', this.currentChatFile);
                break;
            }
        }

        // If still not found, try fuzzy matching for edge cases
        if (!this.currentNode) {
            const currentFileLower = this.currentChatFile.toLowerCase().trim();
            
            for (const [uuid, node] of this.nodeMap) {
                const nodeNameLower = node.name.toLowerCase().trim();
                
                // Case-insensitive match
                if (nodeNameLower === currentFileLower) {
                    this.currentNode = node;
                    console.log('[Chat Branches] Found current node with case-insensitive match:', this.currentChatFile);
                    break;
                }
                
                // Try partial match (for cases where file extensions might differ)
                if (nodeNameLower.includes(currentFileLower) || currentFileLower.includes(nodeNameLower)) {
                    this.currentNode = node;
                    console.log('[Chat Branches] Found current node with partial match:', this.currentChatFile, '->', node.name);
                    break;
                }
            }
        }

        // If still not found, log warning with helpful info
        if (!this.currentNode) {
            console.warn('[Chat Branches] Current chat not found in tree:', this.currentChatFile);
            if (this.currentChatUUID) {
                console.warn('[Chat Branches] Current chat UUID:', this.currentChatUUID);
            }
            console.warn('[Chat Branches] Available nodes in tree:', Array.from(this.nodeMap.values()).map(n => n.name));
            
            // Set the first node as fallback to prevent empty tree display
            if (this.nodeMap.size > 0) {
                const firstNode = this.nodeMap.values().next().value;
                console.warn('[Chat Branches] Falling back to first node:', firstNode.name);
                this.currentNode = firstNode;
            }
        }
    }

    isolateActiveTree() {
        if (!this.currentNode) {
            // If current chat not found, show all trees
            this.treeRoots = [...this.allTreeRoots];
            return;
        }

        // Climb to root
        let root = this.currentNode;
        while (root.parent) {
            root = root.parent;
        }

        // Set current root and only show this tree
        this.currentRootNode = root;
        this.treeRoots = [root];
    }

    expandActivePath() {
        if (!this.currentNode) return;

        let curr = this.currentNode;
        while (curr) {
            if (curr.parent) {
                this.expandedUUIDs.add(curr.parent.id);
            }
            curr = curr.parent;
        }
    }

    // =========================================================================
    // LEGACY FALLBACK (Keep existing logic for backwards compatibility)
    // =========================================================================

    async loadAndBuildTreeLegacy() {
        try {
            const allChats = await this.fetchChats();
            const enrichedChats = await this.hydrateChatMetadata(allChats);
            this.buildGraphLegacy(enrichedChats);
            this.isolateActiveTree();
            this.expandActivePath();
            this.render();
            this.centerOnActive();
        } catch (err) {
            console.error('[Chat Branches] Legacy fallback failed:', err);
            $('#chat_tree_content').html(`<div class="chat-tree-error">Error: ${err.message}</div>`);
        }
    }

    async fetchChats() {
        const response = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.token },
            body: JSON.stringify({ avatar_url: this.characters[this.this_chid].avatar }),
        });
        if (!response.ok) throw new Error('Failed to fetch chat list');
        return await response.json();
    }

    async hydrateChatMetadata(chats) {
        const batchSize = 10;
        const enriched = [];
        
        const fetchMeta = async (chat) => {
            const name = chat.file_name.replace('.jsonl', '');
            try {
                const res = await fetch('/api/chats/get', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.token },
                    body: JSON.stringify({
                        ch_name: this.characters[this.this_chid].name,
                        file_name: name,
                        avatar_url: this.characters[this.this_chid].avatar,
                    }),
                });
                const data = await res.json();
                return { 
                    ...chat, 
                    cleanName: name, 
                    metadata: data[0]?.chat_metadata || {} 
                };
            } catch (e) {
                return { ...chat, cleanName: name, metadata: {} };
            }
        };

        for (let i = 0; i < chats.length; i += batchSize) {
            const batch = chats.slice(i, i + batchSize);
            const results = await Promise.all(batch.map(c => fetchMeta(c)));
            enriched.push(...results);
            $('.chat-tree-loading-text').text(`Scanning ${Math.min(enriched.length, chats.length)} / ${chats.length} chats...`);
        }
        return enriched;
    }

    buildGraphLegacy(chats) {
        this.nodeMap.clear();
        const nodesByName = new Map();

        // Pass 1: Create Nodes
        chats.forEach(c => {
            const uuid = c.metadata.uuid || `legacy_${c.cleanName}`;
            const node = {
                id: uuid,
                name: c.cleanName,
                parentId: c.metadata.parent_uuid,
                children: [],
                data: { ...c, chat_name: c.cleanName },
                parent: null
            };
            this.nodeMap.set(uuid, node);
            nodesByName.set(c.cleanName, node);
        });

        // Pass 2: Link Parents
        const roots = [];
        for (const node of this.nodeMap.values()) {
            if (node.parentId && this.nodeMap.has(node.parentId)) {
                const parent = this.nodeMap.get(node.parentId);
                parent.children.push(node);
                node.parent = parent;
            } else {
                roots.push(node);
            }
        }

        this.treeRoots = roots;
        this.currentNode = nodesByName.get(this.currentChatFile);
    }

    // =========================================================================
    // RENDERING LOGIC
    // =========================================================================

    render() {
        const $container = $('#chat_tree_content');
        $container.empty();

        if (this.treeRoots.length === 0) {
            $container.html('<div class="chat-tree-empty">No connected chat history found.</div>');
            return;
        }

        const treeHtml = `
            <div class="family-tree-wrapper">
                <svg id="chat_tree_lines"></svg>
                <div class="family-tree-inner">
                    ${this.treeRoots.map(root => this.renderNodeRecursive(root, 0)).join('')}
                </div>
            </div>
        `;

        $container.html(treeHtml);
        this.drawLines();
        this.bindEvents();
    }

    renderNodeRecursive(node, level) {
        const isActive = node.name === this.currentChatFile;
        const isExpanded = this.expandedUUIDs.has(node.id);
        const hasChildren = node.children && node.children.length > 0;
        const isRenaming = this.isRenaming && this.renameNode?.id === node.id;
        
        // Truncate name
        const displayLabel = node.name.length > 15 ? node.name.substring(0, 15) + '...' : node.name;
        const msgCount = node.data.message_count || node.data.chat_items || node.data.branch_point || 0;

        return `
            <div class="tree-branch">
                <div class="tree-entry">
                    <div class="tree-node ${isActive ? 'active-node' : ''} ${isRenaming ? 'renaming' : ''}"
                         data-uuid="${node.id}"
                         data-name="${node.name}"
                         title="${node.name}${msgCount ? ` (Branch at msg ${msgCount})` : ''}">
                         
                        <div class="node-content">
                            <span class="node-icon"><i class="fa-solid fa-message"></i></span>
                            ${isRenaming ? this.renderRenameInput(node) : `
                                <span class="node-label">${displayLabel}</span>
                                <span class="rename-icon" data-uuid="${node.id}" title="Rename chat">
                                    <i class="fa-solid fa-pencil"></i>
                                </span>
                            `}
                        </div>

                        ${hasChildren ? `
                            <div class="expand-toggle ${isExpanded ? 'open' : ''}">
                                <i class="fa-solid ${isExpanded ? 'fa-minus' : 'fa-plus'}"></i>
                            </div>
                        ` : ''}
                    </div>
                </div>

                ${(hasChildren && isExpanded) ? `
                    <div class="tree-children">
                        ${node.children.map(child => this.renderNodeRecursive(child, level + 1)).join('')}
                    </div>
                ` : ''}
            </div>
        `;
    }

    drawLines() {
        const $svg = $('#chat_tree_lines');
        const $wrapper = $('.family-tree-wrapper');
        
        $svg.attr('width', $wrapper[0].scrollWidth);
        $svg.attr('height', $wrapper[0].scrollHeight);
        $svg.empty();

        $('.tree-node').each((_, el) => {
            const $node = $(el);
            const $parentBranch = $node.closest('.tree-branch');
            const $childrenContainer = $parentBranch.children('.tree-children');

            if ($childrenContainer.length > 0 && $childrenContainer.is(':visible')) {
                const startRect = $node.offset();
                const containerRect = $wrapper.offset();

                const x1 = (startRect.left - containerRect.left) + ($node.outerWidth() / 2) + $wrapper.scrollLeft();
                const y1 = (startRect.top - containerRect.top) + $node.outerHeight() + $wrapper.scrollTop();

                $childrenContainer.children('.tree-branch').each((_, childBranch) => {
                    const $childNode = $(childBranch).children('.tree-entry').children('.tree-node');
                    const childRect = $childNode.offset();

                    const x2 = (childRect.left - containerRect.left) + ($childNode.outerWidth() / 2) + $wrapper.scrollLeft();
                    const y2 = (childRect.top - containerRect.top) + $wrapper.scrollTop();

                    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    const cY = (y1 + y2) / 2;
                    
                    path.setAttribute('d', `M${x1},${y1} C${x1},${cY} ${x2},${cY} ${x2},${y2}`);
                    path.setAttribute('stroke', '#666');
                    path.setAttribute('fill', 'none');
                    path.setAttribute('stroke-width', '2');
                    
                    $svg.append(path);
                });
            }
        });
    }

    renderRenameInput(node) {
        return `
            <div class="rename-input-container">
                <input type="text"
                       class="rename-input"
                       value="${node.name}"
                       data-uuid="${node.id}"
                       maxlength="255"
                       placeholder="Enter new name"
                       autocomplete="off"
                       spellcheck="false">
                <div class="rename-actions">
                    <button class="rename-confirm" data-uuid="${node.id}" title="Confirm">
                        <i class="fa-solid fa-check"></i>
                    </button>
                    <button class="rename-cancel" data-uuid="${node.id}" title="Cancel">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
        `;
    }

    // =========================================================================
    // INTERACTION & EVENTS
    // =========================================================================

    bindEvents() {
        const self = this;

        // Bind panning first
        this.bindPanning();

        // Use event delegation and remove old handlers first
        $('#chat_tree_content').off('click.expandToggle', '.expand-toggle')
                               .off('dblclick.treeNodeDblclick', '.tree-node')
                               .off('contextmenu.chatTree')
                               .off('click.renameIcon', '.rename-icon')
                               .off('keydown.renameInput', '.rename-input')
                               .off('click.renameConfirm', '.rename-confirm')
                               .off('click.renameCancel', '.rename-cancel');
        $(document).off('click.renameOutside');
        
        $('#chat_tree_content').on('click.expandToggle', '.expand-toggle', function(e) {
            e.stopPropagation();
            const uuid = $(this).closest('.tree-node').data('uuid');
            
            if (self.expandedUUIDs.has(uuid)) {
                self.expandedUUIDs.delete(uuid);
            } else {
                self.expandedUUIDs.add(uuid);
            }
            
            self.render();
        });

        $('#chat_tree_content').on('dblclick.treeNodeDblclick', '.tree-node', async function(e) {
            e.stopPropagation();
            
            // Prevent multiple simultaneous swaps
            if (self.isSwappingChat) {
                console.log('[Chat Branches] Chat swap already in progress, ignoring double-click');
                return;
            }
            
            const name = $(this).data('name');
            
            if (name === self.currentChatFile) return;

            $(this).addClass('loading-node');
            await self.swapChat(name);
        });

        // Handle pencil icon click
        $('#chat_tree_content').on('click.renameIcon', '.rename-icon', function(e) {
            e.stopPropagation();
            const uuid = $(this).data('uuid');
            self.startRename(uuid);
        });

        // Handle rename input interactions
        $('#chat_tree_content').on('keydown.renameInput', '.rename-input', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                const uuid = $(this).data('uuid');
                const newName = $(this).val().trim();
                self.confirmRename(uuid, newName);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                self.cancelRename();
            }
        });

        // Handle confirm button click
        $('#chat_tree_content').on('click.renameConfirm', '.rename-confirm', function(e) {
            e.stopPropagation();
            const uuid = $(this).data('uuid');
            const $input = $(`.rename-input[data-uuid="${uuid}"]`);
            const newName = String($input.val()).trim();
            self.confirmRename(uuid, newName);
        });

        // Handle cancel button click
        $('#chat_tree_content').on('click.renameCancel', '.rename-cancel', function(e) {
            e.stopPropagation();
            self.cancelRename();
        });

        // Handle click outside to cancel
        $(document).on('click.renameOutside', function(e) {
            if (self.isRenaming && !$(e.target).closest('.rename-input-container').length) {
                self.cancelRename();
            }
        });

        // Long-press detection for mobile context menu
        let longPressTimer = null;
        const LONG_PRESS_DURATION = 500; // ms

        $('#chat_tree_content').on('touchstart.chatTree', '.tree-node', function(e) {
            if (e.touches.length === 1) {
                const $node = $(this);
                const touch = e.originalEvent.touches[0];
                
                // Start long-press timer
                longPressTimer = setTimeout(() => {
                    // Trigger context menu on long press
                    const touchEvent = {
                        clientX: touch.clientX,
                        clientY: touch.clientY,
                        target: e.target,
                        preventDefault: () => {},
                        stopPropagation: () => {}
                    };
                    
                    // Find the closest tree-node
                    const $treeNode = $node;
                    const uuid = $treeNode.data('uuid');
                    const name = $treeNode.data('name');
                    
                    // Find the full node object from nodeMap
                    self.contextMenuNode = self.nodeMap.get(uuid) || { uuid, name };
                    self.contextMenu.show(touch.clientX, touch.clientY, [
                        { id: 'view-messages', label: 'View Messages', icon: 'fa-solid fa-comments' }
                    ]);
                }, LONG_PRESS_DURATION);
            }
        });

        // Long-press detection for blank space
        $('#chat_tree_content').on('touchstart.chatTreeBlank', function(e) {
            // Only trigger if not clicking on a tree node or expand toggle
            if (e.touches.length === 1 && $(e.target).closest('.tree-node, .expand-toggle, .context-menu-option').length === 0) {
                const touch = e.originalEvent.touches[0];
                
                // Start long-press timer
                longPressTimer = setTimeout(() => {
                    // Show blank area context menu
                    self.contextMenuNode = null;
                    self.contextMenu.show(touch.clientX, touch.clientY, [
                        { id: 'expand-all', label: 'Expand All Nodes', icon: 'fa-solid fa-expand' },
                        { id: 'collapse-all', label: 'Collapse All Nodes', icon: 'fa-solid fa-compress' },
                        { id: 'find-current', label: 'Find Current Node', icon: 'fa-solid fa-crosshairs' }
                    ]);
                }, LONG_PRESS_DURATION);
            }
        });

        // Cancel long-press on touch move or end (for nodes)
        $('#chat_tree_content').on('touchmove.chatTree touchend.chatTree touchcancel.chatTree', '.tree-node', function() {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        });

        // Cancel long-press on touch move or end (for blank space)
        $('#chat_tree_content').on('touchmove.chatTreeBlank touchend.chatTreeBlank touchcancel.chatTreeBlank', function() {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        });

        // Clean up long-press timer on hide
        this.clearLongPressTimer = function() {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        };

        // Single unified contextmenu handler for both nodes and empty area
        $('#chat_tree_content').on('contextmenu.chatTree', function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            // Check if clicking on a tree node
            const $treeNode = $(e.target).closest('.tree-node');
            if ($treeNode.length > 0) {
                const uuid = $treeNode.data('uuid');
                const name = $treeNode.data('name');
                // Find the full node object from nodeMap
                self.contextMenuNode = self.nodeMap.get(uuid) || { uuid, name };
                self.contextMenu.show(e.clientX, e.clientY, [
                    { id: 'view-messages', label: 'View Messages', icon: 'fa-solid fa-comments' }
                ]);
                return;
            }
            
            // Only show empty area menu if not clicking on interactive elements
            if ($(e.target).closest('.tree-node, .expand-toggle').length === 0) {
                self.contextMenu.show(e.clientX, e.clientY, [
                    { id: 'expand-all', label: 'Expand All Nodes', icon: 'fa-solid fa-expand' },
                    { id: 'collapse-all', label: 'Collapse All Nodes', icon: 'fa-solid fa-compress' },
                    { id: 'find-current', label: 'Find Current Node', icon: 'fa-solid fa-crosshairs' }
                ]);
            }
        });
    }

    async swapChat(chatName) {
        this.isSwappingChat = true;
        
        try {
            await this.openCharacterChat(chatName);
            this.currentChatFile = chatName;
            
            // Reload tree from plugin for updated perspective
            await this.loadAndBuildTree();
            
            toastr.success('Chat switched successfully');
        } catch (err) {
            console.error('[Chat Branches] Error swapping chat:', err);
            toastr.error('Failed to swap chat');
        } finally {
            this.isSwappingChat = false;
        }
    }

    centerOnActive() {
        const $active = $('.active-node');
        const $container = $('#chat_tree_content');
        
        if ($active.length && $container.length) {
            const activeOffset = $active.offset();
            const containerOffset = $container.offset();
            
            $container.scrollTop(
                $container.scrollTop() + (activeOffset.top - containerOffset.top) - ($container.height() / 2) + ($active.height() / 2)
            );
            $container.scrollLeft(
                $container.scrollLeft() + (activeOffset.left - containerOffset.left) - ($container.width() / 2) + ($active.width() / 2)
            );
        }
    }

    expandAllNodes() {
        // Add all node IDs with children to expanded set
        for (const node of this.nodeMap.values()) {
            if (node.children && node.children.length > 0) {
                this.expandedUUIDs.add(node.id);
            }
        }
        this.render();
        this.drawLines();
    }

    collapseAllNodes() {
        // Clear all expanded nodes
        this.expandedUUIDs.clear();
        this.render();
        this.drawLines();
    }

    // =========================================================================
    // RENAME FUNCTIONALITY
    // =========================================================================

    startRename(uuid) {
        const node = this.nodeMap.get(uuid);
        if (!node) return;

        this.isRenaming = true;
        this.renameNode = node;
        this.render(); // Re-render to show input field

        // Focus and select the input
        setTimeout(() => {
            const $input = $(`.rename-input[data-uuid="${uuid}"]`);
            $input.focus();
            $input.select();
        }, 50);
    }

    async confirmRename(uuid, newName) {
        if (!this.isRenaming || !this.renameNode) return;

        const node = this.nodeMap.get(uuid);
        if (!node) return;

        // Check if name hasn't changed
        if (newName === node.name) {
            toastr.info('Chat name unchanged');
            this.cancelRename();
            return;
        }

        // Validate name
        const validation = this.renameHandler.validateName(newName, this.treeRoots, uuid);
        if (!validation.valid) {
            toastr.error(validation.error, 'Rename Failed');
            return;
        }

        // Show loading state
        const $input = $(`.rename-input[data-uuid="${uuid}"]`);
        $input.prop('disabled', true);

        try {
            // Perform rename
            await this.renameHandler.performRename(uuid, node.name, newName);
            
            const wasActiveChat = node.name === this.currentChatFile;
            
            // Update current chat file name if we renamed the active chat
            if (wasActiveChat) {
                this.currentChatFile = newName;
                // Update character's chat reference
                if (this.characters[this.this_chid]) {
                    this.characters[this.this_chid].chat = newName;
                }
            }
            
            // Update local state
            node.name = newName;
            node.data.chat_name = newName;
            
            // Clear rename state before reloading
            this.isRenaming = false;
            this.renameNode = null;
            
            // Refresh tree
            await this.loadAndBuildTree();
            
            // If we renamed the active chat, reload it to stay on it
            if (wasActiveChat) {
                await this.openCharacterChat(newName);
            }
            
            toastr.success('Chat renamed successfully');
        } catch (error) {
            console.error('[Chat Branches] Rename failed:', error);
            toastr.error(error.message || 'Failed to rename chat', 'Rename Failed');
            $input.prop('disabled', false);
            $input.focus();
            return;
        }

        this.isRenaming = false;
        this.renameNode = null;
    }

    cancelRename() {
        if (!this.isRenaming) return;
        
        this.isRenaming = false;
        this.renameNode = null;
        this.render();
    }

    // =========================================================================
    // ROOT DROPDOWN FUNCTIONALITY
    // =========================================================================

    populateRootDropdown() {
        const $dropdown = $('#chat_tree_root_dropdown');
        $dropdown.empty();

        // Hide dropdown if only one or no root exists
        if (this.allTreeRoots.length <= 1) {
            $dropdown.parent().hide();
            return;
        }

        $dropdown.parent().show();

        // Add options for each root
        this.allTreeRoots.forEach(root => {
            const displayName = root.name.length > 30 ? root.name.substring(0, 30) + '...' : root.name;
            const $option = $('<option>')
                .val(root.id)
                .text(displayName)
                .attr('title', root.name);
            
            // Mark as selected if this is the current root
            if (this.currentRootNode && root.id === this.currentRootNode.id) {
                $option.prop('selected', true);
            }
            
            $dropdown.append($option);
        });
    }

    async handleRootChange(rootUUID) {
        const selectedRoot = this.allTreeRoots.find(root => root.id === rootUUID);
        
        if (!selectedRoot) {
            console.error('[Chat Branches] Root not found:', rootUUID);
            return;
        }

        // Don't switch if already on this root
        if (this.currentRootNode && selectedRoot.id === this.currentRootNode.id) {
            return;
        }

        // Update current root
        this.currentRootNode = selectedRoot;

        // Switch to the root's chat
        await this.swapChat(selectedRoot.name);
    }

    // =========================================================================
    // UTILITIES
    // =========================================================================

    async renderModalSkeleton() {
        $('#chat_tree_overlay').remove();
        $('style#chat-tree-styles').remove();

        // Load external CSS file for better maintainability
        const css = await fetch(`/scripts/extensions/third-party/${this.extensionName}/src/css/chat-tree-view.css`).then(r => r.text());
        $('head').append(`<style id="chat-tree-styles">${css}</style>`);

        const html = `
            <div id="chat_tree_overlay">
                <div id="chat_tree_modal">
                    <div id="chat_tree_header">
                        <div class="chat-tree-header-left">
                            <div class="chat-tree-root-selector">
                                <select id="chat_tree_root_dropdown" class="chat-tree-dropdown">
                                    <option value="">Select Root...</option>
                                </select>
                            </div>
                        </div>
                        <div id="chat_tree_close" class="menu_button fa-solid fa-xmark"></div>
                    </div>
                    <div id="chat_tree_content"></div>
                </div>
            </div>
        `;

        $('body').append(html);

        $('#chat_tree_close').on('click', () => this.hide());
        
        // Bind dropdown change event
        $('#chat_tree_root_dropdown').on('change', (e) => {
            const rootUUID = $(e.target).val();
            if (rootUUID) {
                this.handleRootChange(rootUUID);
            }
        });
        
        $('#chat_tree_overlay').on('click', (e) => {
            // Only close if clicking directly on overlay (not when panning or just finished panning)
            if(e.target.id === 'chat_tree_overlay' && !this.isPanning && !this.wasPanning) {
                this.hide();
            }
            // Reset the wasPanning flag after checking
            this.wasPanning = false;
        });
        
        $(window).on('resize.chatTree', () => {
            clearTimeout(this.resizeTimer);
            this.resizeTimer = setTimeout(() => this.drawLines(), 100);
        });
    }

    setLoading(isLoading) {
        if (isLoading) {
            $('#chat_tree_content').html(`
                <div class="chat-tree-loading">
                    <i class="fa-solid fa-spinner fa-spin fa-2x"></i>
                    <div style="margin-top:10px">Loading chat branches...</div>
                    <div class="chat-tree-loading-text" style="font-size:0.8em; opacity:0.7"></div>
                </div>
            `);
        }
    }

    openMessageViewer(node) {
        if (!this.messageViewerPopup) {
            this.messageViewerPopup = new MessageViewerPopup({
                characters: this.characters,
                this_chid: this.this_chid,
                token: this.token,
                openCharacterChat: this.openCharacterChat,
                extensionName: this.extensionName,
                pluginBaseUrl: this.pluginBaseUrl,
                onNavigate: () => this.hide()
            });
        } else {
            // Update dependencies with fresh character data
            this.messageViewerPopup.updateDependencies({
                characters: this.characters,
                this_chid: this.this_chid,
                token: this.token,
                pluginBaseUrl: this.pluginBaseUrl
            });
        }
        // FIX: Attach to document.body so it floats above the tree modal
        // instead of being trapped inside it.
        this.messageViewerPopup.show({
            uuid: node.id || node.uuid,
            name: node.name || node.chat_name
        }, { anchorElement: document.body });
    }

    hide() {
        // Clear long-press timer
        if (this.clearLongPressTimer) {
            this.clearLongPressTimer();
        }
        
        $('#chat_tree_overlay').fadeOut(200, function() { $(this).remove(); });
        $('style#chat-tree-styles').remove();
        $(window).off('resize.chatTree');
        $(document).off('mousemove.chatTree mouseup.chatTree mouseleave.chatTree');
        $('#chat_tree_content').off('mousedown.chatTree touchstart.chatTree touchmove.chatTree touchend.chatTree touchcancel.chatTree touchstart.chatTreeBlank touchmove.chatTreeBlank touchend.chatTreeBlank touchcancel.chatTreeBlank');
        
        // Clean up rename events
        $('#chat_tree_content').off('click.renameIcon');
        $('#chat_tree_content').off('keydown.renameInput');
        $('#chat_tree_content').off('click.renameConfirm');
        $('#chat_tree_content').off('click.renameCancel');
        $(document).off('click.renameOutside');
        
        // Cancel any active rename
        this.cancelRename();
    }

    // =========================================================================
    // PANNING FUNCTIONALITY
    // =========================================================================

    bindPanning() {
        const $c = $('#chat_tree_content');

        $c.on('mousedown.chatTree', e => {
            // Don't pan if clicking on a node, expand button, or other interactive elements
            if ($(e.target).closest('.tree-node, .expand-toggle, .context-menu-option').length || e.button !== 0) return;
            e.preventDefault();
            this.isPanning = true;
            this.panStart = {
                x: e.clientX,
                y: e.clientY,
                scrollX: $c.scrollLeft(),
                scrollY: $c.scrollTop()
            };
            $c.addClass('panning');
        });

        $(document).on('mousemove.chatTree', e => {
            if (!this.isPanning) return;
            $c.scrollLeft(this.panStart.scrollX - (e.clientX - this.panStart.x));
            $c.scrollTop(this.panStart.scrollY - (e.clientY - this.panStart.y));
        });

        $(document).on('mouseup.chatTree mouseleave.chatTree', () => {
            if (this.isPanning) {
                this.isPanning = false;
                this.wasPanning = true; // Mark that we just finished panning
                $('#chat_tree_content').removeClass('panning');
            }
        });
    }
}