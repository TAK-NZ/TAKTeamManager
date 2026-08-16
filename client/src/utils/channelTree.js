/**
 * Pure, framework-free folder-tree parsing for channel lists.
 *
 * Channel "display" strings encode a folder hierarchy using a configurable
 * separator (e.g. " - "). This module turns a flat list of channels into a
 * nested tree of { folders, channels } nodes, without any React/component
 * concerns, so it can be unit/property tested independently of rendering.
 *
 * Extracted from the (previously duplicated) inline `buildFolderTree`
 * implementations in `Dashboard.jsx` and `GlobalChannels.jsx`. Dashboard.jsx
 * keys channels by `display_name`; GlobalChannels.jsx keys them by `name`.
 * The `nameField` parameter preserves both call sites' existing behavior
 * unchanged while removing the duplicated algorithm.
 */

/**
 * Build a nested folder tree from a flat list of channels.
 *
 * @param {Array<Object>} channels - Flat list of channel objects. Each
 *   channel must have a string property named `nameField` containing the
 *   folder-separated display string (e.g. "Region - North - Alpha").
 * @param {string} folderSeparator - The separator used to split a channel's
 *   name into folder path segments (e.g. " - ").
 * @param {string} [nameField='display_name'] - The property on each channel
 *   object that holds the folder-separated name string. Dashboard.jsx uses
 *   `display_name`; GlobalChannels.jsx uses `name`.
 * @returns {{ folders: Object, channels: Array<Object> }} A tree node whose
 *   `folders` maps folder name -> child tree node, and whose `channels`
 *   array holds channels that resolve to this node (with `nameField`
 *   rewritten to just the leaf segment for channels nested in a folder).
 */
export function buildFolderTree(channels, folderSeparator, nameField = 'display_name') {
  const tree = { folders: {}, channels: [] }

  channels.forEach(channel => {
    const parts = channel[nameField].split(folderSeparator)
    if (parts.length === 1) {
      tree.channels.push(channel)
    } else {
      let current = tree
      for (let i = 0; i < parts.length - 1; i++) {
        const folderName = parts[i].trim()
        // Use hasOwnProperty instead of a truthy check: folder names like
        // "valueOf", "toString", or "constructor" would otherwise resolve
        // to an inherited Object.prototype function (always truthy), so a
        // real tree node would never be created and `current` would become
        // that inherited function, crashing later on `.push()`.
        if (!Object.prototype.hasOwnProperty.call(current.folders, folderName)) {
          current.folders[folderName] = { folders: {}, channels: [] }
        }
        current = current.folders[folderName]
      }
      current.channels.push({
        ...channel,
        [nameField]: parts[parts.length - 1].trim()
      })
    }
  })

  return tree
}
