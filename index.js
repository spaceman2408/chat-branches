import {
    eventSource,
    event_types,
    chat_metadata,
    saveSettingsDebounced,
    chat,
    characters,
    this_chid,
    saveChat,
    saveChatConditional,
    openCharacterChat,
    token
} from '../../../../script.js';
import {
    selected_group
} from '../../../group-chats.js';
import { extension_settings } from '../../../extensions.js';
import { uuidv4 } from '../../../utils.js';
import { humanizedDateTime } from '../../../RossAscends-mods.js';
import { POPUP_TYPE, Popup } from '../../../popup.js';
import { ChatTreeView } from './src/ChatTreeView.js';
import { ChatMigrator } from './src/ChatMigrator.js';

/**
 * Chat Branches Extension
 * Injects UUIDs into chat metadata for branch relationship tracking
 */

const extensionName = 'chat-branches';
const PLUGIN_BASE_URL = '/api/plugins/chat-branches-plugin';

let pluginRunning = false;
let notifiedPluginMissing = false;
const PLUGIN_REPO_URL = 'https://github.com/spaceman2408/chat-branches-plugin';

// Show install plugin popup
async function askInstallPlugin() {
    const dom = document.createElement('div');
    dom.classList.add('chat-branches--askInstall');
    
    const head = document.createElement('h3');
    head.textContent = 'Chat Branches - Missing Plugin';
    dom.append(head);
    
    const msg = document.createElement('div');
    msg.textContent = 'You need to install the Chat Branches server plugin for this extension to work. Restart your server after installation:';
    dom.append(msg);
    
    const list = document.createElement('ul');
    const li = document.createElement('li');
    
    const name = document.createElement('div');
    name.textContent = PLUGIN_REPO_URL.split('/').pop();
    li.append(name);
    
    const link = document.createElement('a');
    link.textContent = PLUGIN_REPO_URL;
    link.href = PLUGIN_REPO_URL;
    link.target = '_blank';
    li.append(link);
    
    list.append(li);
    dom.append(list);
    
    const dlg = new Popup(
        dom,
        POPUP_TYPE.TEXT,
        null,
        {
            okButton: 'Close',
        },
    );
    
    await dlg.show();
}

// Check if plugin is running
async function checkPluginStatus() {
    try {
        const response = await fetch(PLUGIN_BASE_URL, { method: 'HEAD' });
        if (response.ok) {
            pluginRunning = true;
        } else {
            throw new Error('Plugin not responding');
        }
    } catch (error) {
        console.error('[Chat Branches] Plugin check failed:', error);
        extension_settings[extensionName].enabled = false;
        saveSettingsDebounced();
    }
}

// Initialize settings
extension_settings[extensionName] = extension_settings[extensionName] || { enabled: true };
if (!extension_settings[extensionName].hasOwnProperty('enabled')) {
    extension_settings[extensionName].enabled = true;
    saveSettingsDebounced();
}

// ============================================================================
// Plugin Communication
// ============================================================================

/**
 * Send branch data to plugin
 * @param {Object} branchData Branch information
 */
async function registerBranchWithPlugin(branchData) {
    if (!extension_settings[extensionName].enabled || !pluginRunning) return;

    try {
        const response = await fetch(`${PLUGIN_BASE_URL}/branch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token
            },
            body: JSON.stringify(branchData)
        });

        const result = await response.json();
        if (!result.success) {
            console.error('[Chat Branches] Failed to register branch:', result.error);
        }
    } catch (error) {
        console.error('[Chat Branches] Error communicating with plugin:', error);
    }
}

/**
 * Update branch metadata in plugin
 * @param {string} uuid Branch UUID
 * @param {Object} updates Fields to update
 */
async function updateBranchInPlugin(uuid, updates) {
    if (!extension_settings[extensionName].enabled || !pluginRunning || !uuid) return;
    
    // Check if updates object is empty or contains only undefined/null values
    const hasValidUpdates = Object.entries(updates).some(([key, value]) =>
        value !== undefined && value !== null && value !== ''
    );
    
    if (!hasValidUpdates) {
        console.log('[Chat Branches] No valid updates to send, skipping API call');
        return;
    }

    try {
        console.log('[Chat Branches] Sending update to stored data:', { uuid, updates });
        const response = await fetch(`${PLUGIN_BASE_URL}/branch/${uuid}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token
            },
            body: JSON.stringify(updates)
        });

        const result = await response.json();
        if (!result.success) {
            console.error('[Chat Branches] Failed to update branch:', result.error);
        }
    } catch (error) {
        console.error('[Chat Branches] Error updating branch in plugin:', error);
    }
}

/**
 * Delete branch from plugin
 * @param {string} uuid Branch UUID
 * @param {boolean} cascade Whether to delete children too
 */
async function deleteBranchFromPlugin(uuid, cascade = false) {
    if (!extension_settings[extensionName].enabled || !pluginRunning || !uuid) return;

    try {
        console.log('[Chat Branches] Deleting branch from stored data:', { uuid, cascade });
        const response = await fetch(`${PLUGIN_BASE_URL}/branch/${uuid}?cascade=${cascade}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token
            }
        });

        const result = await response.json();
        if (!result.success) {
            console.error('[Chat Branches] Failed to delete branch:', result.error);
        } else {
            console.log('[Chat Branches] Branch deleted successfully:', uuid);
        }
    } catch (error) {
        console.error('[Chat Branches] Error deleting branch from plugin:', error);
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

function updateMigrationButtonState(isEnabled) {
    const migrateButton = $('#chat_branches_migrate');
    if (isEnabled && pluginRunning) {
        migrateButton.removeClass('disabled');
        migrateButton.removeAttr('data-disabled-title');
        migrateButton.attr('title', 'Migrate all chats');
    } else {
        migrateButton.addClass('disabled');
        if (!pluginRunning) {
            migrateButton.attr('data-disabled-title', 'Plugin not installed');
            migrateButton.attr('title', 'Migrate all chats (plugin not available)');
        } else {
            migrateButton.attr('data-disabled-title', 'Extension is disabled');
            migrateButton.attr('title', 'Migrate all chats (disabled)');
        }
    }
}

function updateTreeViewButtonsState(enabled) {
    if (!enabled || !pluginRunning) {
        $('#option_chat_tree_view').css('opacity', '0.3').css('pointer-events', 'none');
        $('.mes_chat_tree_view').css('opacity', '0.3').css('pointer-events', 'none');
    } else {
        $('#option_chat_tree_view').css('opacity', '1').css('pointer-events', 'auto');
        $('.mes_chat_tree_view').css('opacity', '1').css('pointer-events', 'auto');
    }
}

// ============================================================================
// Settings Panel
// ============================================================================

async function loadSettingsPanel() {
    const response = await fetch(`/scripts/extensions/third-party/${extensionName}/index.html`);
    if (!response.ok) return;

    const html = await response.text();
    $("#extensions_settings").append(html);

    $("#chat_branches_enabled").prop("checked", extension_settings[extensionName].enabled);

    // Handle checkbox changes to save settings and update UI (like regex extension)
    $("#chat_branches_enabled").on("input", function() {
        const isChecked = !!$(this).prop("checked");
        
        // Prevent enabling if plugin is not running
        if (isChecked && !pluginRunning) {
            toastr.error('Cannot enable extension: Chat Branches plugin is not installed or not running.', 'Plugin Error');
            $(this).prop("checked", false);
            return;
        }
        
        extension_settings[extensionName].enabled = isChecked;
        saveSettingsDebounced();

        // Update text appearance based on toggle state
        const container = $(this).closest('.inline-drawer-content');
        const titleElement = container.find('strong');
        const descElement = container.find('small').first(); // The "If disabled" text

        if (isChecked) {
            titleElement.removeClass('text-muted');
            descElement.removeClass('text-muted');
        } else {
            titleElement.addClass('text-muted');
            descElement.addClass('text-muted');
        }

        // Update migration button state based on extension enabled/disabled
        updateMigrationButtonState(isChecked);
        // Update tree view buttons state
        updateTreeViewButtonsState(isChecked);
    });

    // Initialize text appearance
    const initialChecked = $("#chat_branches_enabled").prop("checked");
    const initialContainer = $("#chat_branches_enabled").closest('.inline-drawer-content');
    const initialTitleElement = initialContainer.find('strong');
    const initialDescElement = initialContainer.find('small').first();

    if (initialChecked) {
        initialTitleElement.removeClass('text-muted');
        initialDescElement.removeClass('text-muted');
    } else {
        initialTitleElement.addClass('text-muted');
        initialDescElement.addClass('text-muted');
    }

    // Initialize migration button state based on extension enabled/disabled and plugin status
    updateMigrationButtonState(initialChecked);
    updateTreeViewButtonsState(initialChecked);
    
    // Handle plugin not running scenario
    if (!pluginRunning) {
        $("#chat_branches_enabled").prop("disabled", true);
        $("#chat_branches_enabled").attr('title', 'Plugin not installed or not running');
        
        // Show install button and message section
        $("#chat_branches_plugin_missing_section").show();
        
        // Show popup notification once
        if (!notifiedPluginMissing) {
            askInstallPlugin();
            notifiedPluginMissing = true;
        }
    } else {
        // Hide install button section if plugin is running
        $("#chat_branches_plugin_missing_section").hide();
    }
}

// ============================================================================
// UUID Management
// ============================================================================

async function ensureChatUUID() {
    // Skip group chats entirely - let SillyTavern handle them
    if (selected_group) {
        return;
    }
    
    if (!extension_settings[extensionName].enabled || !chat_metadata) return;

    let isNewChat = false;

    // Generate UUIDs if missing
    if (!chat_metadata.uuid) {
        chat_metadata.uuid = uuidv4();
        isNewChat = true;
    }
    if (!chat_metadata.root_uuid) {
        chat_metadata.root_uuid = chat_metadata.uuid;
    }

    // Register with plugin if this is a new chat or newly tracked
    if (isNewChat) {
        const characterId = characters[this_chid]?.avatar || null;
        const chatName = characters[this_chid]?.chat || 'Unknown';

        await registerBranchWithPlugin({
            uuid: chat_metadata.uuid,
            parent_uuid: chat_metadata.parent_uuid || null,
            root_uuid: chat_metadata.root_uuid,
            character_id: characterId,
            chat_name: chatName,
            branch_point: null,
            created_at: Date.now()
        });
    }
}

// Hook chat events
eventSource.on(event_types.CHAT_CHANGED, ensureChatUUID);
eventSource.on(event_types.CHAT_CREATED, ensureChatUUID);

// Hook chat renamed event to update plugin
eventSource.on(event_types.CHAT_RENAMED, async (newName) => {
    // Skip group chats entirely - let SillyTavern handle them
    if (selected_group) {
        return;
    }
    
    if (!extension_settings[extensionName].enabled) return;
    
    // Skip if character is not available (can happen during deletion)
    if (!characters[this_chid] || this_chid === undefined) {
        console.log('[Chat Branches] Character not found, skipping chat rename update');
        return;
    }
    
    // Get UUID from chat_metadata or character metadata
    const uuid = chat_metadata?.uuid || characters[this_chid]?.chat_metadata?.uuid;
    
    if (!uuid) {
        console.warn('[Chat Branches] No UUID found for renamed chat, cannot update stored data, ensure extension is enabled.');
        return;
    }

    console.log('[Chat Branches] Updating stored data with new name:', newName, 'for UUID:', uuid);
    
    await updateBranchInPlugin(uuid, {
        chat_name: newName
    });
});

// Also update on CHAT_CHANGED to catch any missed updates
eventSource.on(event_types.CHAT_CHANGED, async () => {
    // Skip group chats entirely - let SillyTavern handle them
    if (selected_group) {
        return;
    }
    
    if (!extension_settings[extensionName].enabled) return;
    
    // Skip if we don't have a valid character or chat metadata
    // This can happen during character deletion
    if (!chat_metadata?.uuid) return;
    
    // For character chats, check this_chid
    if (!characters[this_chid] || this_chid === undefined) return;
    
    const currentChatName = characters[this_chid]?.chat;
    const uuid = chat_metadata.uuid;
    
    // Skip if no valid chat name (can happen during deletion)
    if (!currentChatName) return;
    
    // Update plugin with current name to ensure consistency
    await updateBranchInPlugin(uuid, {
        chat_name: currentChatName
    });
});

// Hook chat deleted event to remove from plugin
eventSource.on(event_types.CHAT_DELETED, async (chatName) => {
    // Skip group chats entirely - let SillyTavern handle them
    if (selected_group) {
        return;
    }
    
    if (!extension_settings[extensionName].enabled) return;
    
    console.log('[Chat Branches] CHAT_DELETED event fired for:', chatName);
    
    // We need to find the UUID for this chat
    // Since the chat is already deleted, we can't get it from chat_metadata
    // We'll need to query the plugin to find branches by chat_name
    
    // If character is being deleted, skip individual chat deletions
    // The CHARACTER_DELETED event will handle cleaning up all branches
    if (!characters[this_chid] || this_chid === undefined) {
        console.log('[Chat Branches] Character not found, skipping chat deletion (will be handled by CHARACTER_DELETED)');
        return;
    }
    
    const characterId = characters[this_chid]?.avatar;
    if (!characterId) {
        console.warn('[Chat Branches] No character ID found, cannot delete branch');
        return;
    }
    
    try {
        const response = await fetch(`${PLUGIN_BASE_URL}/tree/${characterId}`, {
            headers: {
                'X-CSRF-Token': token
            }
        });
        
        const data = await response.json();
        if (!data.success) {
            console.error('[Chat Branches] Failed to fetch tree for deletion:', data.error);
            return;
        }
        
        // Find the branch with matching chat_name
        const findAndDelete = (nodes) => {
            for (const node of nodes) {
                if (node.chat_name === chatName) {
                    console.log('[Chat Branches] Found branch to delete:', node.uuid, node.chat_name);
                    deleteBranchFromPlugin(node.uuid, true); // Cascade delete children
                    return true;
                }
                if (node.children && node.children.length > 0) {
                    if (findAndDelete(node.children)) {
                        return true;
                    }
                }
            }
            return false;
        };
        
        findAndDelete(data.tree);
    } catch (error) {
        console.error('[Chat Branches] Error handling chat deletion:', error);
    }
});

// Hook character deleted event to remove all branches for that character
eventSource.on(event_types.CHARACTER_DELETED, async (data) => {
    const characterId = data?.character?.avatar;
    console.log('[Chat Branches] CHARACTER_DELETED event fired for:', characterId);
    
    if (!characterId) {
        console.warn('[Chat Branches] No character ID in CHARACTER_DELETED event data');
        return;
    }
    
    try {
        const response = await fetch(`${PLUGIN_BASE_URL}/character/${characterId}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': token
            }
        });
        
        const result = await response.json();
        if (!result.success) {
            console.error('[Chat Branches] Failed to delete character data:', result.error);
        } else {
            console.log('[Chat Branches] Successfully deleted character data:', result.message);
        }
    } catch (error) {
        console.error('[Chat Branches] Error handling character deletion:', error);
    }
});

// ============================================================================
// Branch Creation
// ============================================================================

async function createBranchWithUUID(mesId) {
    // Skip group chats entirely - let SillyTavern handle them
    if (selected_group) {
        return null;
    }
    
    if (!chat.length || mesId < 0 || mesId >= chat.length) {
        toastr.warning('Invalid message ID.', 'Branch creation failed');
        return;
    }

    const lastMes = chat[mesId];
    const mainChat = characters[this_chid]?.chat;
    const currentUUID = chat_metadata?.uuid;
    const currentRootUUID = chat_metadata?.root_uuid;

    // Generate new UUID for branch
    const newUUID = uuidv4();

    const newMetadata = {
        main_chat: mainChat,
        uuid: newUUID,
        parent_uuid: currentUUID,
        root_uuid: currentRootUUID || currentUUID
    };

    const name = `Branch #${mesId} - ${humanizedDateTime()}`;
    
    // Save chat with ST
    await saveChat({ chatName: name, withMetadata: newMetadata, mesId });

    // Register branch with plugin
    const characterId = characters[this_chid]?.avatar || null;

    await registerBranchWithPlugin({
        uuid: newUUID,
        parent_uuid: currentUUID,
        root_uuid: currentRootUUID || currentUUID,
        character_id: characterId,
        chat_name: name,
        branch_point: mesId,
        created_at: Date.now()
    });

    // Track branch in parent message
    if (typeof lastMes.extra !== 'object') lastMes.extra = {};
    if (typeof lastMes.extra.branches !== 'object') lastMes.extra.branches = [];
    lastMes.extra.branches.push(name);

    await saveChatConditional();
    return name;
}

function hookBranchButton() {
    $(document).off('click', '.mes_create_branch');
    $(document).on('click', '.mes_create_branch', async function() {
        const mesId = $(this).closest('.mes').attr('mesid');
        if (mesId === undefined) return;

        // Skip group chats entirely - let SillyTavern handle them
        if (selected_group) {
            const { branchChat } = await import('../../../bookmarks.js');
            return branchChat(Number(mesId));
        }

        if (!extension_settings[extensionName].enabled) {
            const { branchChat } = await import('../../../bookmarks.js');
            return branchChat(Number(mesId));
        }

        const result = await createBranchWithUUID(Number(mesId));
        if (result) {
            await openCharacterChat(result);
        }
    });
}

setTimeout(hookBranchButton, 1000);

// ============================================================================
// Tree View Integration
// ============================================================================

// Create tree view instance with dependencies
const chatTreeView = new ChatTreeView({
    characters,
    this_chid,
    token,
    openCharacterChat,
    extensionName,
    pluginBaseUrl: PLUGIN_BASE_URL,
    selected_group
});

// Create migrator instance with dependencies
const chatMigrator = new ChatMigrator({
    characters,
    this_chid,
    token,
    extensionName,
    uuidv4,
    registerBranchWithPlugin,
    selected_group
});

function addTreeViewButton() {
    if ($('#option_chat_tree_view').length > 0) return;

    const treeViewButton = `
        <a id="option_chat_tree_view">
            <i class="fa-lg fa-solid fa-sitemap"></i>
            <span>Chat Branches</span>
        </a>
    `;

    const manageChatOption = $('#option_select_chat');
    if (manageChatOption.length > 0) {
        manageChatOption.after(treeViewButton);
    }
}

function addMessageTreeViewButton() {
    // Add button to each message's button container
    $('.mes_buttons').each(function() {
        const $container = $(this);
        
        // Check if button already exists
        if ($container.find('.mes_chat_tree_view').length > 0) return;
        
        // Find the create branch button to insert before it
        const $createBranch = $container.find('.mes_create_branch');
        
        if ($createBranch.length > 0) {
            const treeViewButton = `
                <div title="Chat Branches" class="mes_button mes_chat_tree_view fa-solid fa-sitemap interactable" data-i18n="[title]Chat Branches" tabindex="0" role="button"></div>
            `;
            $createBranch.before(treeViewButton);
        }
    });
}

function hookMessageTreeViewButton() {
    $(document).on('click', '.mes_chat_tree_view', async function() {
        // Check if plugin is running before showing tree view
        if (!pluginRunning) {
            toastr.error('Chat Branches plugin is not installed or not running.', 'Plugin Error');
            return;
        }
        
        // Update dependencies before showing (this_chid may have changed)
        chatTreeView.updateDependencies({
            characters,
            this_chid,
            token,
            pluginBaseUrl: PLUGIN_BASE_URL,
            selected_group
        });
        
        chatTreeView.show();
    });
}

function hookOptionsMenu() {
    $(document).on('click', '#options_button', function() {
        setTimeout(() => addTreeViewButton(), 100);
    });

    setTimeout(() => addTreeViewButton(), 1000);
}

// Hook message events to add tree view button
eventSource.on(event_types.CHAT_CHANGED, addMessageTreeViewButton);
eventSource.on(event_types.MESSAGE_RECEIVED, addMessageTreeViewButton);
eventSource.on(event_types.MESSAGE_SENT, addMessageTreeViewButton);
eventSource.on(event_types.MESSAGE_UPDATED, addMessageTreeViewButton);

// ============================================================================
// Initialize Extension
// ============================================================================

jQuery(async function() {
    await checkPluginStatus();
    await loadSettingsPanel();
    await ensureChatUUID();
    hookOptionsMenu();
    hookMessageTreeViewButton();

    // Add buttons to existing messages
    setTimeout(addMessageTreeViewButton, 1000);

    $(document).on('click', '#option_chat_tree_view', function() {
        // Check if plugin is running before showing tree view
        if (!pluginRunning) {
            toastr.error('Chat Branches plugin is not installed or not running.', 'Plugin Error');
            $('#options').hide();
            $('#options_button').removeClass('active');
            return;
        }
        
        $('#options').hide();
        $('#options_button').removeClass('active');

        // Update dependencies before showing (this_chid may have changed)
        chatTreeView.updateDependencies({
            characters,
            this_chid,
            token,
            pluginBaseUrl: PLUGIN_BASE_URL,
            selected_group
        });
        
        chatTreeView.show();
    });

    // Bind migration button click
    $(document).on('click', '#chat_branches_migrate', function() {
        // Update dependencies before migrating (this_chid may have changed)
        chatMigrator.updateDependencies({
            characters,
            this_chid,
            token,
            uuidv4,
            registerBranchWithPlugin,
            selected_group
        });

        chatMigrator.showMigrationDialog();
    });

    // Bind install plugin button click
    $(document).on('click', '#chat_branches_install_plugin', async function() {
        await askInstallPlugin();
    });
});