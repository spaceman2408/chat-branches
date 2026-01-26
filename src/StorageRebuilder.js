/**
 * StorageRebuilder - Rebuilds plugin storage from chat files with existing UUIDs
 * Unlike ChatMigrator, this does NOT modify chat files - it only reads metadata
 * and rebuilds the plugin storage from chats that already have UUIDs
 */

import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../../../scripts/popup.js';

/**
 * Check if a chat is a checkpoint (bookmark)
 * Checkpoints are identified by the pattern 'Checkpoint #' in the chat name
 * @param {string} chatName - The chat name to check
 * @returns {boolean} - True if the chat is a checkpoint
 */
function isCheckpointChat(chatName) {
    return chatName && chatName.includes('Checkpoint #');
}

export class StorageRebuilder {
    constructor(dependencies) {
        // Store dependencies
        this.characters = dependencies.characters;
        this.this_chid = dependencies.this_chid;
        this.token = dependencies.token;
        this.extensionName = dependencies.extensionName;
        this.uuidv4 = dependencies.uuidv4;
        this.registerBranchWithPlugin = dependencies.registerBranchWithPlugin;
        this.pluginBaseUrl = dependencies.pluginBaseUrl;
        this.selected_group = dependencies.selected_group;

        // State
        this.isRebuilding = false;
    }

    /**
     * Show the rebuild dialog with appropriate warning/info message
     */
    async showRebuildDialog() {
        if (this.isRebuilding) {
            toastr.warning('Rebuild already in progress', 'Storage Rebuild');
            return;
        }

        try {
            // Skip group chats - this extension only works with character chats
            if (this.selected_group) {
                toastr.error('Group chats are not supported by this extension', 'Storage Rebuild');
                return;
            }

            // Validate dependencies
            if (!this.characters || this.this_chid === undefined || this.this_chid === null) {
                toastr.error('No character selected', 'Storage Rebuild');
                return;
            }

            const character = this.characters[this.this_chid];
            if (!character) {
                toastr.error('Selected character not found', 'Storage Rebuild');
                return;
            }

            // Check if storage exists
            const storageExists = await this.checkStorageExists(character.avatar);

            // Build dialog content based on storage state
            let dialogContent;
            if (storageExists) {
                dialogContent = '<div style="text-align: center;">' +
                    '<i class="fa-solid fa-triangle-exclamation" style="font-size: 48px; color: #f59e0b; margin-bottom: 16px;"></i>' +
                    '<p><strong>Storage already exists for this character.</strong></p>' +
                    '<p>This will merge/add branches from chat files to the existing storage.</p>' +
                    '<p>Only chats with UUIDs will be processed.</p>' +
                    '<p style="font-size: 0.9em; opacity: 0.7; margin-top: 8px;">Use this if storage is corrupted or missing branches.</p>' +
                    '</div>';
            } else {
                dialogContent = '<div style="text-align: center;">' +
                    '<i class="fa-solid fa-circle-info" style="font-size: 48px; color: #3b82f6; margin-bottom: 16px;"></i>' +
                    '<p><strong>No storage found for this character.</strong></p>' +
                    '<p>This will rebuild storage from chat files with UUIDs.</p>' +
                    '<p>Only chats with UUIDs will be processed.</p>' +
                    '<p style="font-size: 0.9em; opacity: 0.7; margin-top: 8px;">Chats without UUIDs will be skipped.</p>' +
                    '</div>';
            }

            // Show confirmation popup
            const confirmed = await Popup.show.confirm(
                'Rebuild Storage',
                dialogContent
            );

            if (!confirmed) return;

            // Start rebuild
            await this.startRebuild();

        } catch (error) {
            console.error('StorageRebuilder: Error showing dialog:', error);
            toastr.error('Failed to open rebuild dialog', 'Rebuild Error');
        }
    }

    /**
     * Check if storage exists for a character
     * @param {string} characterId - Character avatar ID
     * @returns {Promise<boolean>} - True if storage exists
     */
    async checkStorageExists(characterId) {
        try {
            const response = await fetch(`${this.pluginBaseUrl}/tree/${characterId}`, {
                headers: { 'X-CSRF-Token': this.token }
            });

            if (!response.ok) {
                // If 404, storage doesn't exist
                if (response.status === 404) {
                    return false;
                }
                throw new Error('Failed to check storage');
            }

            const data = await response.json();
            // Storage exists if we have a successful response with a tree
            return data.success && data.tree && data.tree.length > 0;
        } catch (error) {
            console.error('StorageRebuilder: Error checking storage:', error);
            // Assume storage doesn't exist on error
            return false;
        }
    }

    /**
     * Start the rebuild process
     */
    async startRebuild() {
        if (this.isRebuilding) return;

        try {
            // Skip group chats
            if (this.selected_group) {
                throw new Error('Group chats are not supported by this extension');
            }

            // Validate dependencies
            if (!this.characters || this.this_chid === undefined || this.this_chid === null) {
                throw new Error('No character selected');
            }

            const character = this.characters[this.this_chid];
            if (!character) {
                throw new Error('Selected character not found');
            }

            this.isRebuilding = true;

            // Show progress popup
            const progressContent = this.buildProgressContent();
            const progressPopup = new Popup(progressContent, POPUP_TYPE.TEXT, null, {
                okButton: false,
                cancelButton: false,
                allowVerticalScrolling: true
            });

            // Start rebuild and close popup when done
            const rebuildPromise = this.rebuildStorageFromChats(character, progressPopup).then(result => {
                progressPopup.complete(POPUP_RESULT.AFFIRMATIVE);
                return result;
            });

            // Show progress popup and wait for it to close
            await progressPopup.show();

            // Get rebuild result
            const result = await rebuildPromise;

            this.isRebuilding = false;

            // Show completion popup
            if (result.error) {
                await Popup.show.text(
                    'Rebuild Failed',
                    `<div style="text-align: center;">` +
                    `<i class="fa-solid fa-times-circle" style="font-size: 48px; color: #ef4444; margin-bottom: 16px;"></i>` +
                    `<p>${result.error}</p>` +
                    `</div>`
                );
            } else {
                let summaryText;
                if (result.processedCount === 0 && result.skippedCount === 0) {
                    summaryText = 'No chats found for this character';
                } else if (result.skippedCount > 0) {
                    summaryText = `${result.processedCount} branches rebuilt, ${result.skippedCount} chats skipped (no UUID)`;
                } else {
                    summaryText = `${result.processedCount} branches rebuilt successfully`;
                }

                await Popup.show.text(
                    'Rebuild Complete',
                    `<div style="text-align: center;">` +
                    `<i class="fa-solid fa-check-circle" style="font-size: 48px; color: #10b981; margin-bottom: 16px;"></i>` +
                    `<p>${summaryText}</p>` +
                    `<p style="font-size: 0.9em; opacity: 0.7; margin-top: 8px;">Storage is now ready to use!</p>` +
                    `</div>`
                );
            }

        } catch (error) {
            console.error('StorageRebuilder: Rebuild error:', error);
            this.isRebuilding = false;

            await Popup.show.text(
                'Rebuild Failed',
                `<div style="text-align: center;">` +
                `<i class="fa-solid fa-times-circle" style="font-size: 48px; color: #ef4444; margin-bottom: 16px;"></i>` +
                `<p>${error.message || 'An unexpected error occurred'}</p>` +
                `</div>`
            );
        }
    }

    /**
     * Build progress popup content
     */
    buildProgressContent() {
        return `<div style="text-align: center;">
            <i class="fa-solid fa-spinner fa-spin" style="font-size: 48px; color: #3b82f6; margin-bottom: 16px;"></i>
            <p id="rebuild_status_text">Processing chats...</p>
            <div style="width: 100%; height: 8px; background: rgba(255, 255, 255, 0.08); border-radius: 999px; overflow: hidden; margin: 16px 0;">
                <div id="rebuild_progress_fill" style="height: 100%; background: linear-gradient(90deg, #3b82f6, #8b5cf6); border-radius: 999px; width: 0%; transition: width 0.3s ease;"></div>
            </div>
            <p id="rebuild_progress_text" style="color: #a1a1aa; font-size: 12px; margin: 0;">0 / 0 chats</p>
        </div>`;
    }

    /**
     * Update progress in the popup
     */
    updateProgress(current, total, statusText = null) {
        const percentage = total > 0 ? (current / total) * 100 : 0;

        const fillElement = document.getElementById('rebuild_progress_fill');
        const textElement = document.getElementById('rebuild_progress_text');
        const statusElement = document.getElementById('rebuild_status_text');

        if (fillElement) fillElement.style.width = `${percentage}%`;
        if (textElement) textElement.textContent = `${current} / ${total} chats`;
        if (statusElement && statusText) statusElement.textContent = statusText;
    }

    /**
     * Rebuild storage from all chats for a character
     */
    async rebuildStorageFromChats(character, progressPopup) {
        let processedCount = 0;
        let skippedCount = 0;
        const BATCH_SIZE = 50;

        try {
            // Fetch all chats
            this.updateProgress(0, 0, 'Fetching chats...');
            const chats = await this.fetchAllChats(character);

            if (!chats || chats.length === 0) {
                return { processedCount: 0, skippedCount: 0 };
            }

            this.updateProgress(0, chats.length, 'Processing chats...');

            // First pass: collect all branch data from chat files
            const branchDataList = [];
            const uuidToChatName = new Map(); // Track UUID to chat name mapping

            this.updateProgress(0, chats.length, 'Reading chat metadata...');

            for (let i = 0; i < chats.length; i++) {
                const chatData = chats[i];
                const chatName = chatData.file_name.replace(/\.jsonl$/g, '');

                try {
                    this.updateProgress(i, chats.length, `Reading ${chatName}...`);

                    // Skip checkpoint chats - they are bookmarks, not true branches
                    if (isCheckpointChat(chatName)) {
                        console.log(`[StorageRebuilder] Skipping checkpoint chat: ${chatName}`);
                        skippedCount++;
                        continue;
                    }

                    // Fetch the full chat data
                    const fullChatData = await this.fetchFullChatData(character, chatName);

                    if (fullChatData && Array.isArray(fullChatData) && fullChatData.length > 0) {
                        const firstEntry = fullChatData[0];

                        // Check if chat has UUID metadata
                        if (firstEntry.chat_metadata && firstEntry.chat_metadata.uuid) {
                            const uuid = firstEntry.chat_metadata.uuid;
                            const parentUuid = firstEntry.chat_metadata.parent_uuid || null;
                            const rootUuid = firstEntry.chat_metadata.root_uuid || uuid;
                            const branchPoint = firstEntry.chat_metadata.branch_point || null;

                            // Check for duplicate UUID (data corruption issue)
                            if (uuidToChatName.has(uuid)) {
                                const existingChatName = uuidToChatName.get(uuid);
                                console.error(`[StorageRebuilder] Duplicate UUID ${uuid} in chats "${existingChatName}" and "${chatName}". Skipping "${chatName}".`);
                                skippedCount++;
                                continue; // Skip this chat
                            }

                            // Track UUID to chat name mapping
                            uuidToChatName.set(uuid, chatName);

                            branchDataList.push({
                                uuid,
                                parent_uuid: parentUuid,
                                root_uuid: rootUuid,
                                character_id: character.avatar,
                                chat_name: String(chatName), // Ensure string to prevent "used as a key" warnings
                                branch_point: branchPoint,
                                created_at: chatData.create_date || Date.now()
                            });
                        } else {
                            // Skip chat without UUID
                            skippedCount++;
                        }
                    } else {
                        skippedCount++;
                    }
                } catch (error) {
                    console.error(`[StorageRebuilder] Error reading chat ${chatName}:`, error);
                    skippedCount++;
                }
            }

            console.log(`[StorageRebuilder] Collected ${branchDataList.length} branches, ${skippedCount} chats skipped`);

            // Second pass: validate and fix parent relationships before registering
            this.updateProgress(0, branchDataList.length, 'Validating branches...');

            // Validate and fix parent relationships
            const validatedBranches = this.validateAndFixBranches(branchDataList, uuidToChatName);

            this.updateProgress(0, validatedBranches.length, 'Registering branches...');

            // Sort branches: roots first, then by creation date
            const sortedBranches = this.sortBranchesForRegistration(validatedBranches);

            // Register branches in batches
            const totalBatches = Math.ceil(sortedBranches.length / BATCH_SIZE);

            for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
                const startIdx = batchIndex * BATCH_SIZE;
                const endIdx = Math.min(startIdx + BATCH_SIZE, sortedBranches.length);
                const batch = sortedBranches.slice(startIdx, endIdx);

                // Update status to show current batch
                this.updateProgress(startIdx, sortedBranches.length,
                    `Registering batch ${batchIndex + 1} of ${totalBatches}...`);

                // Register each branch in the current batch
                for (let i = 0; i < batch.length; i++) {
                    const branchData = batch[i];
                    const globalIndex = startIdx + i;

                    try {
                        this.updateProgress(globalIndex, sortedBranches.length, `Registering ${branchData.chat_name}...`);

                        // Register with plugin
                        await this.registerBranchWithPlugin(branchData);

                        processedCount++;
                    } catch (error) {
                        console.error(`[StorageRebuilder] Error registering branch ${branchData.chat_name}:`, error);
                        skippedCount++;
                    }

                    this.updateProgress(globalIndex + 1, sortedBranches.length);
                }

                // Add a small delay between batches
                if (batchIndex < totalBatches - 1) {
                    this.updateProgress(endIdx, sortedBranches.length,
                        `Pausing to free resources... (${batchIndex + 1}/${totalBatches} batches done)`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }

            return { processedCount, skippedCount };
        } catch (error) {
            console.error('StorageRebuilder: Error during rebuild:', error);
            return { processedCount, skippedCount, error: error.message };
        }
    }

    /**
     * Sort branches to ensure parents are registered before children
     * Uses topological sort based on UUID parent-child relationships
     * @param {Array} branches - Array of branch data objects
     * @returns {Array} - Sorted array with parents before children
     */
    sortBranchesForRegistration(branches) {
        // Create a map for quick lookup
        const branchMap = new Map(branches.map(b => [b.uuid, b]));

        // Build adjacency list for topological sort
        const visited = new Set();
        const temp = new Set();
        const sorted = [];

        // Visit function for topological sort
        const visit = (uuid) => {
            if (visited.has(uuid)) {
                return; // Already processed
            }
            if (temp.has(uuid)) {
                console.warn(`[StorageRebuilder] Circular dependency detected for ${uuid}`);
                return;
            }

            const branch = branchMap.get(uuid);
            if (!branch) {
                console.warn(`[StorageRebuilder] Branch not found in map: ${uuid}`);
                return;
            }

            // Mark as temporarily visited
            temp.add(uuid);

            // Visit parent first if it exists
            if (branch.parent_uuid) {
                visit(branch.parent_uuid);
            }

            // Mark as permanently visited and add to sorted list
            temp.delete(uuid);
            visited.add(uuid);
            sorted.push(branch);
        };

        // Visit all branches
        for (const branch of branches) {
            visit(branch.uuid);
        }

        return sorted;
    }

    /**
     * Validate and fix parent relationships in branch data
     * Only marks as orphaned if parent truly doesn't exist in collected data
     * @param {Array} branches - Array of branch data objects
     * @param {Map} uuidToChatName - Map of UUID to chat name (from collected data)
     * @returns {Array} - Validated branch data with fixed relationships
     */
    validateAndFixBranches(branches, uuidToChatName) {
        const validated = [];
        let orphanedCount = 0;

        for (const branch of branches) {
            // Check if parent exists in our collected data
            if (branch.parent_uuid && !uuidToChatName.has(branch.parent_uuid)) {
                // Parent doesn't exist in collected data - this branch is orphaned
                console.warn(`[StorageRebuilder] Orphaned branch: ${branch.chat_name} (parent ${branch.parent_uuid} not found)`);

                // Create a copy with parent_uuid set to null
                const fixedBranch = { ...branch, parent_uuid: null };
                validated.push(fixedBranch);
                orphanedCount++;
            } else {
                // Parent exists or no parent - keep as is
                validated.push(branch);
            }
        }

        if (orphanedCount > 0) {
            console.log(`[StorageRebuilder] Fixed ${orphanedCount} orphaned branches`);
        }

        return validated;
    }

    /**
     * Fetch all chats for a character
     */
    async fetchAllChats(character) {
        const response = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': this.token
            },
            body: JSON.stringify({ avatar_url: character.avatar })
        });

        if (!response.ok) {
            throw new Error('Failed to fetch chats');
        }

        return await response.json();
    }

    /**
     * Fetch full chat data
     */
    async fetchFullChatData(character, chatName) {
        const response = await fetch('/api/chats/get', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': this.token
            },
            body: JSON.stringify({
                ch_name: character.name,
                file_name: chatName,
                avatar_url: character.avatar
            })
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch chat data: ${chatName}`);
        }

        return await response.json();
    }

    /**
     * Update dependencies (needed because this_chid may change)
     */
    updateDependencies(dependencies) {
        if (dependencies.characters !== undefined) this.characters = dependencies.characters;
        if (dependencies.this_chid !== undefined) this.this_chid = dependencies.this_chid;
        if (dependencies.token !== undefined) this.token = dependencies.token;
        if (dependencies.uuidv4 !== undefined) this.uuidv4 = dependencies.uuidv4;
        if (dependencies.registerBranchWithPlugin !== undefined) {
            this.registerBranchWithPlugin = dependencies.registerBranchWithPlugin;
        }
        if (dependencies.pluginBaseUrl !== undefined) this.pluginBaseUrl = dependencies.pluginBaseUrl;
        if (dependencies.selected_group !== undefined) this.selected_group = dependencies.selected_group;
    }
}
