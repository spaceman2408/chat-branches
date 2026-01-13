/**
 * MessageViewerPopup - Displays chat messages from a selected branch
 * Refactored for performance and readability.
 */
export class MessageViewerPopup {
    constructor(dependencies) {
        // Dependencies
        this.deps = dependencies; // Store all deps in one object to save lines
        this.token = dependencies.token; // Keep freq used ones handy
        
        // State
        this.state = {
            chatName: null,
            chatUUID: null,
            messages: [],
            isLoading: false,
            isDestroyed: false,
            swipeIndices: new Map(),
            expandedMessages: new Set()
        };

        // DOM Elements
        this.$element = null;
        this.$overlay = null;

        // Bindings
        this._handleGlobalEvents = this._handleGlobalEvents.bind(this);
    }

    // =================================================================================
    // Public API
    // =================================================================================

    updateDependencies(newDeps) {
        if (this.state.isDestroyed) return;
        this.deps = { ...this.deps, ...newDeps };
        if (newDeps.token) this.token = newDeps.token;
    }

    async show(chatData, options = {}) {
        if (this.state.isDestroyed || !chatData?.uuid) return;

        this.state.chatUUID = chatData.uuid;
        this.state.chatName = chatData.name || chatData.chat_name;
        this.state.messages = [];
        this.state.swipeIndices.clear();
        this.state.expandedMessages.clear();

        try {
            await this._ensureDom();
            this._bindEvents();
            await this._loadMessages();
        } catch (error) {
            console.error('[Chat Branches][Message Viewer] Show error:', error);
            this._renderError(error.message);
        }
    }

    hide() {
        this._unbindEvents();
        if (this.$overlay) {
            this.$overlay.removeClass('visible');
            setTimeout(() => {
                this.$overlay?.remove();
                this.$overlay = null;
            });
        }
        // Clear message data to free memory - important for large chats
        this.state.messages = [];
        this.state.swipeIndices.clear();
        this.state.expandedMessages.clear();
        // Reset state
        this.state.chatName = null;
        this.state.chatUUID = null;
    }

    destroy() {
        this.state.isDestroyed = true;
        this.hide();
        this.deps = null;
    }

    // =================================================================================
    // Data Loading & Processing
    // =================================================================================

    async _loadMessages() {
        this.state.isLoading = true;
        this._renderLoading();

        try {
            const character = this.deps.characters[this.deps.this_chid];
            if (!character) throw new Error('Character not loaded');

            // 1. Get Branch Info (for Chat Name)
            const branchRes = await this._fetchJson(`${this.deps.pluginBaseUrl}/branch/${this.state.chatUUID}`);
            if (!branchRes?.branch?.chat_name) throw new Error('Branch data missing');
            
            this.state.chatName = branchRes.branch.chat_name;
            this._updateTitle();

            // 2. Fetch Messages (Strategy Pattern: Try A, then B, then C)
            let rawData = await this._fetchChatDataStrategy(character);
            
            // 3. Process
            this.state.messages = this._processRawMessages(rawData);
            this._renderList();

        } catch (error) {
            console.error('[Chat Branches][Message Viewer] Load failed:', error);
            this._renderError(error.message);
        } finally {
            this.state.isLoading = false;
        }
    }

    async _fetchChatDataStrategy(character) {
        const payload = { 
            ch_name: character.name, 
            file_name: this.state.chatName, 
            avatar_url: character.avatar 
        };

        // Attempt 1: Standard API (exact name)
        let data = await this._fetchApi('/api/chats/get', payload);
        
        // Attempt 2: Standard API (.jsonl appended)
        if (!data) {
            payload.file_name += '.jsonl';
            data = await this._fetchApi('/api/chats/get', payload);
        }

        // Attempt 3: Plugin Fallback
        if (!data || (Array.isArray(data) && data.length === 0)) {
            console.warn('[Chat Branches][Message Viewer] API empty, trying plugin fallback...');
            const pluginData = await this._fetchJson(
                `${this.deps.pluginBaseUrl}/messages/${this.state.chatUUID}`, 
                { method: 'POST', body: JSON.stringify({ character_name: character.name }) }
            );
            if (pluginData?.success) data = pluginData.messages;
        }

        if (!data) throw new Error('Could not load chat data');
        return data;
    }

    // Helper wrapper for Fetch
    async _fetchJson(url, options = {}) {
        options.headers = { ...options.headers, 'X-CSRF-Token': this.token, 'Content-Type': 'application/json' };
        const res = await fetch(url, options);
        if (!res.ok) return null;
        return await res.json();
    }

    async _fetchApi(url, body) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.token },
                body: JSON.stringify(body)
            });
            if (!res.ok) return null;
            return await res.json();
        } catch { return null; }
    }

    _processRawMessages(data) {
        if (!data) return [];
        const list = Array.isArray(data) ? data : (data.messages || Object.values(data));
        
        return list
            .filter(entry => entry && (entry.mes !== undefined || entry.name || entry.is_user))
            .map((entry, idx) => {
                const swipes = Array.isArray(entry.swipes) ? entry.swipes : [entry.mes];
                const swipeId = entry.swipe_id || 0;
                
                // Initialize swipe state
                this.state.swipeIndices.set(idx, swipeId);

                return {
                    id: idx,
                    sender: entry.name || 'Unknown',
                    content: entry.mes || '',
                    timestamp: MessageViewerPopup.formatTimestamp(entry.send_date),
                    isUser: !!entry.is_user,
                    isSystem: !!entry.is_system,
                    swipes: swipes,
                    swipeCount: swipes.length
                };
            });
    }

    // =================================================================================
    // Rendering & UI
    // =================================================================================

    async _ensureDom() {
        $('#message_viewer_overlay').remove();
        
        // Inject Styles if not exists
        if (!$('#message-viewer-styles').length) {
            const cssPath = `/scripts/extensions/third-party/${this.deps.extensionName}/src/css/message-viewer-popup.css`;
            $('head').append(`<link id="message-viewer-styles" rel="stylesheet" href="${cssPath}">`);
        }

        const html = `
            <div id="message_viewer_overlay" class="message-viewer-overlay">
                <div class="message-viewer-popup">
                    <div class="message-viewer-header">
                        <h3 id="message_viewer_title"><i class="fa-solid fa-comments"></i> <span>Loading...</span></h3>
                        <button id="message_viewer_close" class="message-viewer-btn"><i class="fa-solid fa-times"></i></button>
                    </div>
                    <div id="message_viewer_content" class="message-viewer-content"></div>
                </div>
            </div>`;

        $('body').append(html);
        this.$overlay = $('#message_viewer_overlay');
        setTimeout(() => this.$overlay.addClass('visible'), 10);
    }

    _renderLoading() {
        $('#message_viewer_content').html(`
            <div class="message-viewer-loading">
                <i class="fa-solid fa-spinner fa-spin"></i> <div>Loading messages...</div>
            </div>`);
    }

    _renderError(msg) {
        $('#message_viewer_content').html(`
            <div class="message-viewer-error">
                <i class="fa-solid fa-exclamation-triangle"></i>
                <div>${MessageViewerPopup.escapeHtml(msg)}</div>
                <button id="message_viewer_retry" class="message-viewer-btn">Retry</button>
            </div>`);
        $('#message_viewer_retry').on('click', () => this._loadMessages());
    }

    _renderList() {
        if (!this.state.messages.length) {
            $('#message_viewer_content').html('<div class="message-viewer-empty"><i class="fa-solid fa-inbox"></i> No messages</div>');
            return;
        }

        const html = this.state.messages.map(msg => this._buildMessageHtml(msg)).join('');
        $('#message_viewer_content').html(`<div class="message-viewer-list">${html}</div>`);
    }

    _buildMessageHtml(msg) {
        const currentIndex = this.state.swipeIndices.get(msg.id) || 0;
        const currentContent = String(msg.swipes[currentIndex] || msg.content);
        
        const isExpanded = this.state.expandedMessages.has(msg.id);
        const shouldTruncate = !isExpanded && currentContent.length > 500;
        const displayContent = shouldTruncate ? currentContent.substring(0, 500) + '...' : currentContent;

        const typeClass = msg.isUser ? 'user-message' : (msg.isSystem ? 'system-message' : 'assistant-message');
        
        // Controls HTML
        const expandBtn = shouldTruncate ? 
            `<button class="expand-message-btn" data-id="${msg.id}"><i class="fa-solid fa-expand"></i> Expand</button>` : '';
        
        const swipeControls = (msg.swipeCount > 1 && !msg.isUser) ? `
            <div class="swipe-controls">
                <button class="swipe-arrow prev" data-id="${msg.id}" ${currentIndex === 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button>
                <span class="swipe-counter">${currentIndex + 1}/${msg.swipeCount}</span>
                <button class="swipe-arrow next" data-id="${msg.id}" ${currentIndex === msg.swipeCount - 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button>
            </div>` : '';

        return `
            <div class="message-viewer-item ${typeClass}" data-id="${msg.id}">
                <div class="message-header">
                    <span class="message-sender">${MessageViewerPopup.escapeHtml(msg.sender)}</span>
                    <span class="message-timestamp">${msg.timestamp}</span>
                </div>
                <div class="message-content ${shouldTruncate ? 'truncated' : ''}">${MessageViewerPopup.escapeHtml(displayContent)}</div>
                ${expandBtn} ${swipeControls}
            </div>`;
    }

    _updateTitle() {
        const name = this.state.chatName || 'Messages';
        $('#message_viewer_title span').text(name.length > 40 ? name.substring(0, 40) + '...' : name);
    }


    // =================================================================================
    // Event Handling (Centralized)
    // =================================================================================

    _bindEvents() {
        $('#message_viewer_close').on('click', () => this.hide());
        
        // Event Delegation: One listener for the whole list
        const $content = $('#message_viewer_content');
        $content.on('click', (e) => {
            const target = $(e.target);
            
            // Handle Swipe Arrows
            const swipeBtn = target.closest('.swipe-arrow');
            if (swipeBtn.length) {
                e.stopPropagation();
                this._handleSwipe(parseInt(swipeBtn.data('id')), swipeBtn.hasClass('prev') ? -1 : 1);
                return;
            }

            // Handle Expand
            const expandBtn = target.closest('.expand-message-btn');
            if (expandBtn.length) {
                e.stopPropagation();
                this._handleExpand(parseInt(expandBtn.data('id')));
                return;
            }

            // Handle Message Click (Navigation)
            const item = target.closest('.message-viewer-item');
            if (item.length && !target.closest('.swipe-controls').length) {
                this._navigateToMessage(parseInt(item.data('id')));
            }
        });

        // Global events
        $(document).on('keydown.mv', this._handleGlobalEvents);
        
        // DELAYED BINDING: Wait 100ms so the click that opened this doesn't close it
        setTimeout(() => {
            if (!this.state.isDestroyed && this.$overlay) {
                $(document).on('click.mv', this._handleGlobalEvents);
            }
        }, 100);

    }

    _unbindEvents() {
        $('#message_viewer_close, #message_viewer_content').off();
        $(document).off('.mv');
        $(window).off('.mv');
    }

    _handleGlobalEvents(e) {
        if (e.type === 'keydown' && e.key === 'Escape') this.hide();
        if (e.type === 'click' && !$(e.target).closest('.message-viewer-popup, #chat_tree_modal').length) this.hide();
    }

    _handleSwipe(id, dir) {
        const msg = this.state.messages[id];
        if (!msg) return;
        
        const current = this.state.swipeIndices.get(id) || 0;
        const next = current + dir;
        
        if (next >= 0 && next < msg.swipes.length) {
            this.state.swipeIndices.set(id, next);
            // Re-render just this item
            $(`.message-viewer-item[data-id="${id}"]`).replaceWith(this._buildMessageHtml(msg));
        }
    }

    _handleExpand(id) {
        this.state.expandedMessages.add(id);
        const msg = this.state.messages[id];
        $(`.message-viewer-item[data-id="${id}"]`).replaceWith(this._buildMessageHtml(msg));
    }

    async _navigateToMessage(id) {
        const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        try {
            // 1. Context Check: Switch chat if needed
            const character = this.deps.characters[this.deps.this_chid];
            const activeChat = character ? character.chat : null;

            if (activeChat !== this.state.chatName) {
                await this.deps.openCharacterChat(this.state.chatName);
                await wait(500);
            }

            if (this.deps.onNavigate) this.deps.onNavigate(this.state.chatName, id);
            this.hide();

            // 2. The "Hunt" Loop
            for (let attempt = 0; attempt < 30; attempt++) {
                const $msg = $(`.mes[mesid="${id}"]`);

                if ($msg.length) {
                    $msg[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await wait(1000);
                    $msg.addClass('message-highlight-flash');
                    setTimeout(() => $msg.removeClass('message-highlight-flash'), 3000);
                    return;
                }

                const $showMoreBtn = $('#show_more_messages');

                if (!$showMoreBtn.length || !$showMoreBtn.is(':visible')) {
                    console.warn('[Chat Branches][Message Viewer] Message not found and no more history available.');
                    break;
                }

                $showMoreBtn[0].scrollIntoView({ behavior: 'auto', block: 'center' });
                await wait(200);

                // We fire the standard click, then manually dispatch the mouse event sequence
                // to satisfy any specific listeners (like mousedown/mouseup binders).
                try {
                    const element = $showMoreBtn[0];
                    
                    element.click();

                    ['mousedown', 'mouseup', 'click'].forEach(eventType => {
                        const event = new MouseEvent(eventType, {
                            view: window,
                            bubbles: true,
                            cancelable: true,
                            buttons: 1
                        });
                        element.dispatchEvent(event);
                    });
                } catch (err) {
                    console.warn('[Chat Branches][Message Viewer] Native click failed, trying jQuery trigger', err);
                    $showMoreBtn.trigger('click');
                }
                // We wait longer (1.5s) to ensure the network request and DOM injection finish
                await wait(1500);
            }
            console.warn('[Chat Branches][Message Viewer] Message not found after all attempts. Try increasing # Msg. to Load in User Settings.');
            if (typeof toastr !== 'undefined') {
                toastr.warning('Message not found (it may be deleted or unreachable).');
            }

        } catch (e) {
            console.error('[Chat Branches][Message Viewer] Navigation error:', e);
        }
    }

    // =================================================================================
    // Static Helpers
    // =================================================================================

    static escapeHtml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    static formatTimestamp(ts) {
        if (!ts) return 'Unknown';
        try {
            let date;
            
            // Try direct parsing first (handles standard ISO and timestamp formats)
            date = new Date(ts);
            
            // If that fails, try parsing older formats like "March 11, 2025 5:03pm"
            if (isNaN(date.getTime())) {
                // Parse format: "Month Day, Year Hour:Minutes(am/pm)"
                // Examples: "March 11, 2025 5:03pm", "January 1, 2024 12:30am"
                const dateMatch = ts.match(/^(\w+)\s+(\d+),\s*(\d{4})\s*(\d{1,2}):(\d{2})(am|pm)$/i);
                
                if (dateMatch) {
                    const [, monthStr, day, year, hour, minute, ampm] = dateMatch;
                    const months = ['January', 'February', 'March', 'April', 'May', 'June',
                                   'July', 'August', 'September', 'October', 'November', 'December'];
                    const monthIndex = months.indexOf(monthStr);
                    
                    if (monthIndex !== -1) {
                        let hours = parseInt(hour, 10);
                        if (ampm.toLowerCase() === 'pm' && hours !== 12) {
                            hours += 12;
                        } else if (ampm.toLowerCase() === 'am' && hours === 12) {
                            hours = 0;
                        }
                        
                        date = new Date(parseInt(year, 10), monthIndex, parseInt(day, 10), hours, parseInt(minute, 10));
                    }
                }
            }
            
            // If still invalid, return Unknown
            if (isNaN(date.getTime())) return 'Unknown';
            
            // Always show both date and time for clarity
            const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
            
            return `${dateStr} ${timeStr}`;
        } catch { return 'Unknown'; }
    }
}