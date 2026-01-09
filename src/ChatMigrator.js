/**
 * ChatMigrator - Handles migration of existing chat files to include UUIDs
 * Allows users to add UUIDs to chats that were created before the extension was installed
 * Now registers migrated chats with the plugin for instant tree view access
 */

import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../../../scripts/popup.js';

export class ChatMigrator {
    constructor(dependencies) {
        // Store dependencies
        this.characters = dependencies.characters;
        this.this_chid = dependencies.this_chid;
        this.token = dependencies.token;
        this.extensionName = dependencies.extensionName;
        this.uuidv4 = dependencies.uuidv4;
        this.registerBranchWithPlugin = dependencies.registerBranchWithPlugin;
        this.selected_group = dependencies.selected_group;

        // State
        this.isMigrating = false;
    }

    /**
     * Show the migration dialog using built-in popups
     */
    async showMigrationDialog() {
        if (this.isMigrating) {
            toastr.warning('Migration already in progress', 'Chat Migration');
            return;
        }

        try {
            // Show confirmation popup
            const confirmed = await Popup.show.confirm(
                'Migrate All Chats',
                '<div style="text-align: center;">' +
                '<i class="fa-solid fa-exclamation-triangle" style="font-size: 48px; color: #f59e0b; margin-bottom: 16px;"></i>' +
                '<p><strong>This action cannot be undone.</strong></p>' +
                '<p>Please back up your chats before proceeding.</p>' +
                '<p>After migration, each chat and branch will get unique ids, and be registered with the server plugin.</p>' +
                '<p><strong>Migrated chats do not get viewable trees, you are only giving them unique identifiers for tracking. TL;DR This makes every chat file a root chat.</strong></p>' +
                '</div>'
            );

            if (!confirmed) return;

            // Start migration
            await this.startMigration();

        } catch (error) {
            console.error('ChatMigrator: Error showing dialog:', error);
            toastr.error('Failed to open migration dialog', 'Migration Error');
        }
    }

    /**
     * Start the migration process
     */
    async startMigration() {
        if (this.isMigrating) return;

        try {
            // Skip group chats - this extension only works with character chats
            // Check this first, as this_chid will be undefined for group chats
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

            this.isMigrating = true;

            // Show progress popup
            const progressContent = this.buildProgressContent();
            const progressPopup = new Popup(progressContent, POPUP_TYPE.TEXT, null, {
                okButton: false,
                cancelButton: false,
                allowVerticalScrolling: true
            });

            // Start migration and close popup when done
            const migrationPromise = this.migrateAllChats(character, progressPopup).then(result => {
                progressPopup.complete(POPUP_RESULT.AFFIRMATIVE);
                return result;
            });

            // Show progress popup and wait for it to close
            await progressPopup.show();

            // Get migration result
            const result = await migrationPromise;

            this.isMigrating = false;

            // Show completion popup
            if (result.error) {
                await Popup.show.text(
                    'Migration Failed',
                    `<div style="text-align: center;">` +
                    `<i class="fa-solid fa-times-circle" style="font-size: 48px; color: #ef4444; margin-bottom: 16px;"></i>` +
                    `<p>${result.error}</p>` +
                    `</div>`
                );
            } else {
                let summaryText;
                if (result.successCount === 0 && result.errorCount === 0) {
                    summaryText = 'All chats already have unique IDs';
                } else if (result.errorCount > 0) {
                    summaryText = `${result.successCount} chats migrated, ${result.errorCount} had errors`;
                } else {
                    summaryText = `${result.successCount} chats migrated and registered with plugin`;
                }

                await Popup.show.text(
                    'Migration Complete',
                    `<div style="text-align: center;">` +
                    `<i class="fa-solid fa-check-circle" style="font-size: 48px; color: #10b981; margin-bottom: 16px;"></i>` +
                    `<p>${summaryText}</p>` +
                    `<p style="font-size: 0.9em; opacity: 0.7; margin-top: 8px;">Tree view is now ready to use!</p>` +
                    `</div>`
                );
            }

        } catch (error) {
            console.error('ChatMigrator: Migration error:', error);
            this.isMigrating = false;

            await Popup.show.text(
                'Migration Failed',
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
            <p id="migration_status_text">Processing chats...</p>
            <div style="width: 100%; height: 8px; background: rgba(255, 255, 255, 0.08); border-radius: 999px; overflow: hidden; margin: 16px 0;">
                <div id="migration_progress_fill" style="height: 100%; background: linear-gradient(90deg, #3b82f6, #8b5cf6); border-radius: 999px; width: 0%; transition: width 0.3s ease;"></div>
            </div>
            <p id="migration_progress_text" style="color: #a1a1aa; font-size: 12px; margin: 0;">0 / 0 chats</p>
        </div>`;
    }

    /**
     * Update progress in the popup
     */
    updateProgress(current, total, statusText = null) {
        const percentage = total > 0 ? (current / total) * 100 : 0;

        const fillElement = document.getElementById('migration_progress_fill');
        const textElement = document.getElementById('migration_progress_text');
        const statusElement = document.getElementById('migration_status_text');

        if (fillElement) fillElement.style.width = `${percentage}%`;
        if (textElement) textElement.textContent = `${current} / ${total} chats`;
        if (statusElement && statusText) statusElement.textContent = statusText;
    }

    /**
     * Migrate all chats for a character
     */
    async migrateAllChats(character, progressPopup) {
        let successCount = 0;
        let errorCount = 0;
        const BATCH_SIZE = 50;

        try {
            // Fetch all chats
            this.updateProgress(0, 0, 'Fetching chats...');
            const chats = await this.fetchAllChats(character);

            if (!chats || chats.length === 0) {
                return { successCount: 0, errorCount: 0 };
            }

            this.updateProgress(0, chats.length, 'Processing chats...');

            // Calculate number of batches
            const totalBatches = Math.ceil(chats.length / BATCH_SIZE);
            
            // Process chats in batches
            for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
                const startIdx = batchIndex * BATCH_SIZE;
                const endIdx = Math.min(startIdx + BATCH_SIZE, chats.length);
                const batch = chats.slice(startIdx, endIdx);
                
                // Update status to show current batch
                this.updateProgress(startIdx, chats.length,
                    `Processing batch ${batchIndex + 1} of ${totalBatches}...`);

                // Process each chat in the current batch
                for (let i = 0; i < batch.length; i++) {
                    const chatData = batch[i];
                    const globalIndex = startIdx + i;
                    const chatName = chatData.file_name.replace(/\.jsonl$/g, '');

                    try {
                        this.updateProgress(globalIndex, chats.length, `Processing ${chatName}...`);

                        // Check if chat needs migration
                        const needsMigration = await this.chatNeedsMigration(character, chatName);

                        if (needsMigration) {
                            // Fetch the full chat data
                            const fullChatData = await this.fetchFullChatData(character, chatName);

                            if (fullChatData && Array.isArray(fullChatData) && fullChatData.length > 0) {
                                const firstEntry = fullChatData[0];

                                // Initialize chat_metadata if it doesn't exist
                                if (!firstEntry.chat_metadata) {
                                    firstEntry.chat_metadata = {};
                                }

                                // Add UUIDs to the metadata
                                if (!firstEntry.chat_metadata.uuid) {
                                    firstEntry.chat_metadata.uuid = this.uuidv4();
                                }
                                if (!firstEntry.chat_metadata.root_uuid) {
                                    firstEntry.chat_metadata.root_uuid = firstEntry.chat_metadata.uuid;
                                }

                                // Save the updated chat
                                const success = await this.migrateChatMetadata(character.avatar, chatName, fullChatData);

                                if (success) {
                                    // Register with plugin
                                    await this.registerBranchWithPlugin({
                                        uuid: firstEntry.chat_metadata.uuid,
                                        parent_uuid: firstEntry.chat_metadata.parent_uuid || null,
                                        root_uuid: firstEntry.chat_metadata.root_uuid,
                                        character_id: character.avatar,
                                        chat_name: chatName,
                                        branch_point: null,
                                        created_at: chatData.create_date || Date.now()
                                    });

                                    successCount++;
                                } else {
                                    errorCount++;
                                }
                            } else {
                                console.warn(`Could not fetch full chat data for ${chatName}`);
                                errorCount++;
                            }
                        } else {
                            // Chat already has UUIDs, but might not be in plugin yet
                            // Register it anyway
                            const fullChatData = await this.fetchFullChatData(character, chatName);
                            if (fullChatData && Array.isArray(fullChatData) && fullChatData.length > 0) {
                                const firstEntry = fullChatData[0];
                                if (firstEntry.chat_metadata?.uuid) {
                                    await this.registerBranchWithPlugin({
                                        uuid: firstEntry.chat_metadata.uuid,
                                        parent_uuid: firstEntry.chat_metadata.parent_uuid || null,
                                        root_uuid: firstEntry.chat_metadata.root_uuid || firstEntry.chat_metadata.uuid,
                                        character_id: character.avatar,
                                        chat_name: chatName,
                                        branch_point: null,
                                        created_at: chatData.create_date || Date.now()
                                    });
                                }
                            }
                        }
                    } catch (error) {
                        console.error(`Error migrating chat ${chatName}:`, error);
                        errorCount++;
                    }

                    this.updateProgress(globalIndex + 1, chats.length);
                }

                // Add a small delay between batches
                if (batchIndex < totalBatches - 1) {
                    this.updateProgress(endIdx, chats.length,
                        `Pausing to free resources... (${batchIndex + 1}/${totalBatches} batches done)`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }

            return { successCount, errorCount };
        } catch (error) {
            console.error('ChatMigrator: Error during migration:', error);
            return { successCount, errorCount, error: error.message };
        }
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
     * Check if a chat needs migration (missing UUID)
     */
    async chatNeedsMigration(character, chatName) {
        try {
            const fullChatData = await this.fetchFullChatData(character, chatName);

            if (!fullChatData || !Array.isArray(fullChatData) || fullChatData.length === 0) {
                return true;
            }

            const firstEntry = fullChatData[0];
            if (!firstEntry.chat_metadata) {
                return true;
            }

            return !firstEntry.chat_metadata.uuid || !firstEntry.chat_metadata.root_uuid;
        } catch (error) {
            console.error(`Error checking chat ${chatName}:`, error);
            return true;
        }
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
        if (dependencies.selected_group !== undefined) this.selected_group = dependencies.selected_group;
    }

    /**
     * Migrate chat metadata by saving the full chat array with updated metadata
     *
     * @param {string} avatarUrl - Avatar filename of the character
     * @param {string} fileName - Name of the chat file
     * @param {Object|Array} chatData - Chat data to save
     * @returns {Promise<boolean>} - True if successful
     */
    async migrateChatMetadata(avatarUrl, fileName, chatData) {
        try {
            const response = await fetch('/api/chats/save', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': this.token
                },
                body: JSON.stringify({
                    chat: Array.isArray(chatData) ? chatData : [chatData],
                    file_name: fileName,
                    avatar_url: avatarUrl
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('Failed to save chat via /api/chats/save:', response.status, errorText);
                return false;
            }

            return true;
        } catch (error) {
            console.error('Error in migrateChatMetadata:', error);
            return false;
        }
    }
}