import { useState, useEffect } from 'react';
import { PlusIcon, KeyIcon, UserPlusIcon, GlobeAltIcon, RadioIcon, SignalIcon, PencilIcon, TrashIcon, FolderIcon, FolderOpenIcon, ChevronRightIcon, ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
// Response/Support/XtraTools use Tabler icons instead of a heroicons
// stand-in: heroicons has no fire-truck/ambulance, digger, or wrench+tools
// glyph, and Tabler (already vetted/added to package.json for this) has an
// exact match for all three -- IconFiretruck, IconBackhoe, IconTool. BCH
// keeps its original heroicons RadioIcon, per explicit request ("leave as
// is"). Tabler components take the same `className` prop heroicons' do, so
// they drop into the existing `h-6 w-6 text-*` classes unchanged.
import { IconFiretruck, IconBackhoe, IconTool } from '@tabler/icons-react';
import toast from 'react-hot-toast';
import { globalChannelsAPI, configAPI } from '../services/api';
import { buildFolderTree } from '../utils/channelTree';
import BchChannelCredentialsDialog from '../components/BchChannelCredentialsDialog';
import AddServiceAccountDialog from '../components/AddServiceAccountDialog';
import ServiceAccountActionConfirmDialog from '../components/ServiceAccountActionConfirmDialog';
import { useTabs, tabAria, TabPanel } from '../components/Tabs';

// Bugfix (too much scrolling): the four channel types render as tabs
// instead of four stacked cards, alphabetically ordered (BCH, Response,
// Support, XtraTools) per explicit request. The tab bar itself stays
// neutral (active/inactive coloring only), matching Admin.jsx's own
// tab-bar convention -- icon-only below `sm:`, full label restored at
// `sm:` and up, accessible name constant either way.
const CHANNEL_TABS = [
  { id: 'bch', label: 'BCH', icon: RadioIcon },
  { id: 'response', label: 'Response', icon: IconFiretruck },
  { id: 'support', label: 'Support', icon: IconBackhoe },
  { id: 'utl', label: 'XtraTools', icon: IconTool }
];

export default function GlobalChannels({ user }) {
  const [bchChannels, setBchChannels] = useState([]);
  // region-channel-tiers: `regionChannels` still holds every region row
  // from the single GET /api/global-channels/region fetch (each row now
  // carries `tier`); the two Response/Support cards below FILTER this one
  // array client-side by `channel.tier` rather than fetching separately.
  const [regionChannels, setRegionChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  // createType/editChannel.type are now 3-way: 'bch' | 'response' | 'support'.
  const [createType, setCreateType] = useState('bch');
  const [editChannel, setEditChannel] = useState(null);
  const [deleteChannel, setDeleteChannel] = useState(null);
  const [deletingChannel, setDeletingChannel] = useState(false);
  const [showAssignDialog, setShowAssignDialog] = useState(false);
  const [assigningUsers, setAssigningUsers] = useState(false);
  const [syncingChannels, setSyncingChannels] = useState(false);
  // region-channel-tiers: separate confirm/loading state for the region
  // seed action, following the same pattern as showAssignDialog/assigningUsers.
  const [showSeedDialog, setShowSeedDialog] = useState(false);
  const [seedingRegions, setSeedingRegions] = useState(false);
  // Bugfix: whether the standard Response/Support region-channel seed set
  // is already complete -- null while unknown (still loading, or the
  // status check itself failed), so the button defaults to SHOWN rather
  // than being hidden on a false negative. Only an explicit `true` from
  // the server hides it.
  const [regionSeedComplete, setRegionSeedComplete] = useState(null);
  const [expandedFolders, setExpandedFolders] = useState(new Set());
  const [folderSeparator, setFolderSeparator] = useState(' - ');
  // Bugfix ("Get credentials" button): the fetched credentials + the
  // channel name they belong to (for the dialog's title), or null when
  // the dialog is closed. Fetched fresh on every click rather than reused
  // from a prior open, matching the enrollment page's own "never cache a
  // secret in state longer than needed" posture.
  const [credentialsDialog, setCredentialsDialog] = useState(null);
  // Bugfix (explicit request: "Add Service Account" modal replacing the
  // one-click Provision action): the channel to name a service account
  // for, or null when the dialog is closed.
  const [addServiceAccountChannel, setAddServiceAccountChannel] = useState(null);
  // Bugfix (explicit request: cycle password / delete service account,
  // both write-in confirmed): which action is pending confirmation, the
  // channel it applies to, and the exact username the admin must type --
  // read straight off the already-open credentials dialog, so this never
  // needs its own separate fetch.
  const [serviceAccountAction, setServiceAccountAction] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    description: ''
  });
  const [activeChannelTab, setActiveChannelTab] = useTabs('bch');

  const isGlobalManager = user?.is_global_manager; // Global managers only

  // region-channel-tiers: the two tier-filtered views every Response/Support
  // card, create/edit modal, and folder-tree helper below reads from.
  const responseChannels = regionChannels.filter((channel) => channel.tier === 'response');
  const supportChannels = regionChannels.filter((channel) => channel.tier === 'support');

  // bch-channel-category: `bchChannels` still holds every row from the
  // single GET /api/global-channels/bch fetch (each row now carries
  // `category`); the two BCH/XtraTools cards below FILTER this one array
  // client-side by `channel.category`, exactly mirroring how
  // responseChannels/supportChannels above split ONE regionChannels
  // fetch by `tier` rather than fetching separately. A row with no
  // `category` at all (defensive only -- the column is NOT NULL with a
  // DEFAULT server-side, so this should never actually happen) falls
  // back to the 'BCH' bucket rather than vanishing from both cards.
  const utlChannels = bchChannels.filter((channel) => channel.category === 'UTL');
  const bchOnlyChannels = bchChannels.filter((channel) => channel.category !== 'UTL');

  // Maps a 4-way channelType ('bch'/'utl'/'response'/'support') to the
  // channel list it renders from and the human-readable label used in
  // headings/dialog titles/toast messages, so the create/edit/render code
  // below reads from one table instead of branching four ways at each
  // call site.
  const CHANNEL_TYPE_META = {
    bch: { label: 'BCH', channels: bchOnlyChannels },
    utl: { label: 'XtraTools', channels: utlChannels },
    response: { label: 'Response', channels: responseChannels },
    support: { label: 'Support', channels: supportChannels }
  };

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const response = await configAPI.getPublic();
        setFolderSeparator(response.data.channel_folder_separator || ' - ');
      } catch (error) {
        console.error('Failed to fetch config:', error);
      }
    };
    
    fetchConfig();
    fetchChannels();
    // The seed-status route is gated server-side by the same
    // 'global_channel:manage' permission the seed action itself
    // requires, and the button it drives is only ever rendered inside
    // the isGlobalManager-gated management card below -- so skip the
    // call entirely for a non-Global_Manager rather than firing a
    // request that would only 403.
    if (isGlobalManager) {
      fetchRegionSeedStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchChannels = async () => {
    try {
      const [bchResponse, regionResponse] = await Promise.all([
        globalChannelsAPI.getBchChannels(),
        globalChannelsAPI.getRegionChannels()
      ]);
      
      setBchChannels(bchResponse.data.channels);
      setRegionChannels(regionResponse.data.channels);
    } catch (error) {
      console.error('Failed to fetch global channels:', error);
      toast.error('Failed to load global channels');
    } finally {
      setLoading(false);
    }
  };

  // Bugfix: refreshes whether the standard region seed set is complete,
  // so the "Seed Standard Region Channels" action can hide itself once
  // there's nothing left to seed. Called on mount and again after a
  // successful seed run -- NOT after every edit/delete of a region
  // channel, since editing an existing standard channel's name/
  // description doesn't remove it from the seeded set (only a delete of
  // one of the 35 standard rows would reintroduce a gap, and re-checking
  // on every fetchChannels() call would mean this status query firing on
  // every unrelated BCH create/edit too).
  const fetchRegionSeedStatus = async () => {
    try {
      const response = await globalChannelsAPI.getRegionSeedStatus();
      setRegionSeedComplete(response.data.missingCount === 0);
    } catch (error) {
      console.error('Failed to fetch region seed status:', error);
      // Leave regionSeedComplete at its current value (defaults to null,
      // i.e. "show the button") rather than assuming completion on a
      // failed check.
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    
    try {
      if (createType === 'bch' || createType === 'utl') {
        // bch-channel-category: 'bch'/'utl' both create a bch_channels
        // row (full parity: service account + read/write group pair),
        // distinguished only by the `category` field the server accepts
        // (server/routes/globalChannels.js validates it's one of the two
        // values; omitted entirely for 'bch' since 'BCH' is the server's
        // own default, matching every pre-existing caller's behavior).
        await globalChannelsAPI.createBchChannel(
          createType === 'utl' ? { ...formData, category: 'UTL' } : formData
        );
      } else {
        // region-channel-tiers: 'response'/'support' both create a region
        // channel row, distinguished only by the `tier` field the server
        // requires (server/routes/globalChannels.js validates it's one of
        // the two values).
        await globalChannelsAPI.createRegionChannel({ ...formData, tier: createType });
      }
      toast.success(`${CHANNEL_TYPE_META[createType].label} channel created successfully`);
      
      setShowCreateModal(false);
      setFormData({ name: '', description: '' });
      fetchChannels();
    } catch (error) {
      toast.error(`Failed to create ${CHANNEL_TYPE_META[createType].label} channel`);
    }
  };

  const handleEdit = (channel, type) => {
    setEditChannel({ ...channel, type });
    setFormData({ name: channel.name, description: channel.description });
    setShowEditModal(true);
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    
    try {
      if (editChannel.type === 'bch' || editChannel.type === 'utl') {
        // bch-channel-category: category is immutable after creation
        // (GlobalChannelService.updateBchChannel reads it back off the
        // row itself), so it is never sent on update -- only
        // name/description change, same as region channels' tier.
        await globalChannelsAPI.updateBchChannel(editChannel.id, formData);
      } else {
        // region-channel-tiers: tier is immutable after creation (it's
        // fixed to the row's own stored value server-side), so it is
        // never sent on update -- only name/description change.
        await globalChannelsAPI.updateRegionChannel(editChannel.id, formData);
      }
      toast.success(`${CHANNEL_TYPE_META[editChannel.type].label} channel updated successfully`);
      
      setShowEditModal(false);
      setEditChannel(null);
      setFormData({ name: '', description: '' });
      fetchChannels();
      // Bugfix: renaming a standard region channel's `name` away from
      // its seeded region name reintroduces a gap in the standard set
      // (the seed check matches by name+tier), so re-check on every
      // response/support edit -- BCH channels are outside the seeded
      // set entirely and never affect this.
      if (editChannel.type === 'response' || editChannel.type === 'support') {
        fetchRegionSeedStatus();
      }
    } catch (error) {
      toast.error(`Failed to update ${CHANNEL_TYPE_META[editChannel.type].label} channel`);
    }
  };

  const handleDelete = (channelId, channelType, channelName) => {
    setDeleteChannel({ id: channelId, type: channelType, name: channelName });
  };

  // region-channel-tiers/bch-channel-category: `deleteChannel.type` carries
  // the 4-way UI type ('bch'/'utl'/'response'/'support'), but
  // DELETE /api/global-channels/:channelType/:channelId is server-scoped
  // to CHANNEL_TABLE_ALLOWLIST's two actual table types -- 'bch'/'region',
  // with no notion of category/tier at all (a bch_channels row is deleted
  // the same way regardless of its category, exactly like a region
  // channel regardless of its tier). This maps the UI type down to the
  // server's channelType before the call.
  const toServerChannelType = (type) => (type === 'response' || type === 'support' ? 'region' : 'bch');

  const confirmDelete = async () => {
    if (!deleteChannel) return;
    
    setDeletingChannel(true);
    try {
      await globalChannelsAPI.deleteChannel(toServerChannelType(deleteChannel.type), deleteChannel.id);
      toast.success(`${CHANNEL_TYPE_META[deleteChannel.type].label} channel deleted successfully`);
      fetchChannels();
      // Bugfix: deleting one of the 35 standard region channels
      // reintroduces a gap in the standard set -- re-check so the Seed
      // button reappears rather than staying hidden. BCH deletes never
      // affect this.
      if (deleteChannel.type === 'response' || deleteChannel.type === 'support') {
        fetchRegionSeedStatus();
      }
      setDeleteChannel(null);
    } catch (error) {
      toast.error(`Failed to delete ${CHANNEL_TYPE_META[deleteChannel.type].label} channel`);
    } finally {
      setDeletingChannel(false);
    }
  };

  // Bugfix: previously copied straight to the clipboard with only a toast
  // for feedback, and did nothing visibly different for a channel with no
  // service account configured at all (most BCH/XtraTools channels have
  // none) -- reading as "the button doesn't work". `channel.service_account_username`
  // is already present on the row from the list fetch (no need to guess at
  // the credentials endpoint's own 403/404 to distinguish "no service
  // account" from "not allowed"/"not found"), so that case short-circuits
  // with a clear message and never calls the credentials endpoint at all.
  //
  // Bugfix (a channel with no service account has no credentials to get):
  // the Get Credentials button itself is now hidden entirely for such a
  // channel (see the render block below) in favor of a Provision Service
  // Account action -- this early-return stays as a defensive fallback for
  // a stale row (e.g. a list snapshot from before another admin just
  // provisioned one), not as the primary way this case is surfaced.
  const handleGetCredentials = async (channel) => {
    if (!channel.service_account_username) {
      toast.error('This channel has no service account configured.');
      return;
    }

    try {
      const response = await globalChannelsAPI.getBchCredentials(channel.id);
      setCredentialsDialog({ channelId: channel.id, channelName: channel.name, credentials: response.data.credentials });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to get credentials');
    }
  };

  // Bugfix (explicit request: "Add Service Account" modal, replacing the
  // former one-click provision action): opens the naming dialog instead
  // of provisioning with the channel-name-derived default directly.
  // `AddServiceAccountDialog` itself calls
  // `globalChannelsAPI.provisionServiceAccount(channelId, username)` on
  // submit and its `onCompleted` refreshes the channel list (see the
  // render block below), so the row picks up its new
  // `service_account_username` and the action switches from Add Service
  // Account back to Get Credentials without needing a manual page reload.
  const handleOpenAddServiceAccount = (channel) => {
    setAddServiceAccountChannel({ id: channel.id, name: channel.name });
  };

  // Bugfix (explicit request: cycle password / delete service account,
  // both write-in confirmed): opens the shared confirm dialog. Called
  // from `BchChannelCredentialsDialog`'s own callback props, so `mode`
  // and `serviceAccountUsername` come from that already-open dialog's
  // own data rather than a fresh fetch.
  const handleServiceAccountAction = (mode, username) => {
    setServiceAccountAction({
      mode,
      channelId: credentialsDialog.channelId,
      channelName: credentialsDialog.channelName,
      serviceAccountUsername: username
    });
  };

  const handleSyncChannels = async () => {
    setSyncingChannels(true);
    try {
      await globalChannelsAPI.syncExistingChannels();
      toast.success('Channel sync completed successfully');
      fetchChannels(); // Refresh the channel lists
    } catch (error) {
      toast.error('Failed to sync existing channels');
    } finally {
      setSyncingChannels(false);
    }
  };

  const handleSeedRegions = async () => {
    setSeedingRegions(true);
    try {
      const response = await globalChannelsAPI.seedRegionChannels();
      const { created, skipped, failed } = response.data;
      toast.success(`Region channels seeded: ${created} created, ${skipped} already existed${failed ? `, ${failed} failed` : ''}`);
      setShowSeedDialog(false);
      fetchChannels();
      // Bugfix: re-check completeness after seeding so the button hides
      // itself immediately, rather than staying visible until a full
      // page reload. Deliberately re-queries the real DB state (rather
      // than assuming success from the counts alone) since a partial
      // failure (failed > 0) must not be reported as complete.
      fetchRegionSeedStatus();
    } catch (error) {
      toast.error('Failed to seed region channels');
    } finally {
      setSeedingRegions(false);
    }
  };

  const handleAssignAllUsers = async () => {
    setAssigningUsers(true);
    try {
      const response = await globalChannelsAPI.assignAllUsers();
      toast.success(`Assignment queued for ${response.data.usersProcessed} users`);
      setShowAssignDialog(false);
    } catch (error) {
      toast.error('Failed to assign users to global channels');
    } finally {
      setAssigningUsers(false);
    }
  };

  const toggleFolder = (folderPath) => {
    const newExpanded = new Set(expandedFolders);
    if (newExpanded.has(folderPath)) {
      newExpanded.delete(folderPath);
    } else {
      newExpanded.add(folderPath);
    }
    setExpandedFolders(newExpanded);
  };

  const getAllFolderPaths = (tree, basePath = '') => {
    const paths = [];
    Object.keys(tree.folders).forEach(folderName => {
      const folderPath = basePath ? `${basePath}/${folderName}` : folderName;
      paths.push(folderPath);
      paths.push(...getAllFolderPaths(tree.folders[folderName], folderPath));
    });
    return paths;
  };

  const expandAllFolders = (channels) => {
    const allPaths = getAllFolderPaths(buildFolderTree(channels, folderSeparator, 'name'));
    setExpandedFolders(new Set(allPaths));
  };

  const collapseAllFolders = () => {
    setExpandedFolders(new Set());
  };

  const renderFolderTree = (tree, path = '', channelType) => {
    const items = [];
    
    // Render folders
    Object.entries(tree.folders).forEach(([folderName, subtree]) => {
      const folderPath = path ? `${path}/${folderName}` : folderName;
      const isExpanded = expandedFolders.has(folderPath);
      
      items.push(
        <div key={folderPath}>
          <div 
            className="flex items-center p-3 bg-gray-100 dark:bg-gray-700 rounded-lg cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600"
            onClick={() => toggleFolder(folderPath)}
          >
            <div className="flex items-center flex-1">
              {isExpanded ? (
                <FolderOpenIcon className="h-5 w-5 text-gray-900 dark:text-gray-100 mr-2" />
              ) : (
                <FolderIcon className="h-5 w-5 text-gray-900 dark:text-gray-100 mr-2" />
              )}
              <span className="font-medium text-gray-900 dark:text-gray-100">{folderName}</span>
            </div>
            <ChevronRightIcon className={`h-4 w-4 text-gray-500 dark:text-gray-300 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
          </div>
        </div>
      );
      
      if (isExpanded) {
        items.push(
          // Bugfix (mobile responsiveness parity with Dashboard.jsx's own
          // Channel_Tree_Row): `ml-3 sm:ml-6` -- each nesting level's
          // indentation compounds with its ancestors', so a few levels
          // deep can push a row's content out of the visible width
          // entirely on a narrow phone. Halving the per-level indent
          // below `sm` keeps the hierarchy visually distinguishable
          // without costing that much horizontal room.
          <div key={`${folderPath}-children`} className="ml-3 sm:ml-6 mt-2 space-y-2">
            {renderFolderTree(subtree, folderPath, channelType)}
          </div>
        );
      }
    });
    
    // Render channels
    tree.channels.forEach(channel => {
      items.push(
        // Bugfix (mobile responsiveness): below `sm:`, the Get
        // credentials/Edit/Delete action icons now drop underneath the
        // channel's own name/description rather than squeezing into a
        // fixed-width column beside them, mirroring Requests.jsx's
        // identical fix for its Approve/Deny column. `ml-3 sm:ml-6`
        // matches the halved-indent fix above.
        <div key={channel.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3 bg-gray-100 dark:bg-gray-700 rounded-lg ml-3 sm:ml-6">
          <div className="flex-1 min-w-0">
            <div className="flex items-center">
              <SignalIcon className="h-4 w-4 text-gray-900 dark:text-gray-100 mr-1.5 flex-shrink-0" />
              <h3 className="font-medium text-gray-900 dark:text-gray-100 break-words">
                {channel.name}
              </h3>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-300 break-words">
              {channel.description}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-500 mt-1 break-words">
              Created by {channel.created_by_name}
              {/* bch-channel-category: a UTL channel gets the exact same
                  service-account/credentials treatment as a BCH channel --
                  both are bch_channels rows with the full read/write-group
                  + service-account machinery, distinguished only by
                  category, not by whether they carry a service account
                  at all. */}
              {(channelType === 'bch' || channelType === 'utl') && channel.service_account_username && (
                <> • Service Account: {channel.service_account_username}</>
              )}
            </p>
          </div>

          {isGlobalManager && (
            // Bugfix (mobile tap targets too small): `p-2 rounded-lg` box
            // around each icon (was a bare h-4 w-4 icon with no padding),
            // matching the tap-target treatment `DeviceListRow.jsx`'s
            // Revoke button and `MemberActions.jsx`'s card variant both
            // use -- grey for the two ordinary actions, red-tinted for
            // the destructive one.
            <div className="flex items-center gap-2 flex-shrink-0">
              {/* Bugfix (a channel with no service account has no
                  credentials to get): Get Credentials only renders once
                  `service_account_username` is actually set -- showing it
                  unconditionally led to "This channel has no service
                  account configured" on every click for a channel
                  discovered via Sync Existing Channels. The alternative,
                  Add Service Account, renders in exactly the opposite
                  case, so a BCH/UTL channel always shows precisely one
                  of the two, never both and never neither. */}
              {(channelType === 'bch' || channelType === 'utl') && channel.service_account_username && (
                <button
                  onClick={() => handleGetCredentials(channel)}
                  className="p-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-blue-600 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-blue-400"
                  title="Get credentials"
                  aria-label={`Get credentials for ${channel.name}`}
                >
                  <KeyIcon className="h-5 w-5" />
                </button>
              )}
              {(channelType === 'bch' || channelType === 'utl') && !channel.service_account_username && (
                <button
                  onClick={() => handleOpenAddServiceAccount(channel)}
                  className="p-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-blue-600 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-blue-400"
                  title="Add service account"
                  aria-label={`Add service account for ${channel.name}`}
                >
                  <UserPlusIcon className="h-5 w-5" />
                </button>
              )}
              <button
                onClick={() => handleEdit(channel, channelType)}
                className="p-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-300"
                title="Edit channel"
                aria-label={`Edit ${channel.name}`}
              >
                <PencilIcon className="h-5 w-5" />
              </button>
              <button
                onClick={() => handleDelete(channel.id, channelType, channel.name)}
                className="p-2 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 dark:bg-red-950/40 dark:hover:bg-red-900/60 dark:text-red-400"
                title="Delete channel"
                aria-label={`Delete ${channel.name}`}
              >
                <TrashIcon className="h-5 w-5" />
              </button>
            </div>
          )}
        </div>
      );
    });
    
    return items;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Global Channels</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Manage BCH (broadcast/ETL), Response (emergency services), Support (all-agency), and XtraTools (maps, overlays and other extras) channels that users have access to.
        </p>
      </div>

      {/* Bugfix (too much scrolling): the four channel types are now tabs
          in one card, alphabetically ordered (BCH, Response, Support,
          XtraTools), instead of four separately-scrolled cards stacked
          on the page. Every `TabPanel` below is `keepMounted` -- content
          is hidden via CSS (`hidden`), never unmounted -- so all four
          folder trees stay in the DOM simultaneously (client/src/pages/
          channelTreeContrast.test.jsx's structural guard mounts this
          page once and expects to find all four sections' Folder_Rows
          at once) and so each tab's Expand/Collapse-All state survives
          switching away and back. */}
      <div className="card">
        <div className="border-b border-gray-200 dark:border-gray-700">
          <nav className="-mb-px flex space-x-3 sm:space-x-6" role="tablist">
            {CHANNEL_TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveChannelTab(tab.id)}
                  aria-label={tab.label}
                  title={tab.label}
                  {...tabAria(activeChannelTab, tab.id)}
                  className={`flex items-center py-4 px-1 border-b-2 font-medium text-sm flex-shrink-0 ${
                    activeChannelTab === tab.id
                      ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
                  }`}
                >
                  <Icon className="h-5 w-5 sm:mr-2" aria-hidden="true" />
                  <span className="hidden sm:inline">{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="pt-4">
          {/* BCH Channels */}
          <TabPanel id="bch" activeTab={activeChannelTab} keepMounted>
            {/* Bugfix: `flex-wrap gap-2` (was a non-wrapping row) so the
                section title, the Expand/Collapse All buttons and the
                section's own Create button can drop to their own line on
                a narrow phone, matching Teams.jsx's own search-bar wrap
                fix -- identical across all four sections below. */}
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <div className="flex items-center">
                <RadioIcon className="h-6 w-6 text-blue-600 mr-2" />
                <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                  BCH Channels (Broadcast/ETL)
                </h2>
              </div>
              <div className="flex items-center gap-2">
                {bchOnlyChannels.length > 0 && Object.keys(buildFolderTree(bchOnlyChannels, folderSeparator, 'name').folders).length > 0 && (
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => expandAllFolders(bchOnlyChannels)}
                      className="inline-flex items-center px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
                    >
                      <ChevronDownIcon className="h-4 w-4 mr-1" />
                      Expand All
                    </button>
                    <button
                      onClick={collapseAllFolders}
                      className="inline-flex items-center px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
                    >
                      <ChevronUpIcon className="h-4 w-4 mr-1" />
                      Collapse All
                    </button>
                  </div>
                )}
                {isGlobalManager && (
                  <button
                    onClick={() => {
                      setCreateType('bch');
                      setShowCreateModal(true);
                    }}
                    className="btn-primary flex items-center justify-center"
                  >
                    <PlusIcon className="h-4 w-4 mr-2 flex-shrink-0" />
                    Create BCH Channel
                  </button>
                )}
              </div>
            </div>

            {bchOnlyChannels.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400">No BCH channels configured.</p>
            ) : (
              <div className="space-y-3">
                {renderFolderTree(buildFolderTree(bchOnlyChannels, folderSeparator, 'name'), '', 'bch')}
              </div>
            )}
          </TabPanel>

          {/* Response Channels */}
          <TabPanel id="response" activeTab={activeChannelTab} keepMounted>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <div className="flex items-center">
                <IconFiretruck className="h-6 w-6 text-red-600 mr-2" />
                <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                  Response Channels (Emergency Services)
                </h2>
              </div>
              <div className="flex items-center gap-2">
                {responseChannels.length > 0 && Object.keys(buildFolderTree(responseChannels, folderSeparator, 'name').folders).length > 0 && (
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => expandAllFolders(responseChannels)}
                      className="inline-flex items-center px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
                    >
                      <ChevronDownIcon className="h-4 w-4 mr-1" />
                      Expand All
                    </button>
                    <button
                      onClick={collapseAllFolders}
                      className="inline-flex items-center px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
                    >
                      <ChevronUpIcon className="h-4 w-4 mr-1" />
                      Collapse All
                    </button>
                  </div>
                )}
                {isGlobalManager && (
                  <button
                    onClick={() => {
                      setCreateType('response');
                      setShowCreateModal(true);
                    }}
                    className="btn-primary flex items-center justify-center"
                  >
                    <PlusIcon className="h-4 w-4 mr-2 flex-shrink-0" />
                    Create Response Channel
                  </button>
                )}
              </div>
            </div>

            {responseChannels.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400">No response channels configured.</p>
            ) : (
              <div className="space-y-3">
                {renderFolderTree(buildFolderTree(responseChannels, folderSeparator, 'name'), '', 'response')}
              </div>
            )}
          </TabPanel>

          {/* Support Channels */}
          <TabPanel id="support" activeTab={activeChannelTab} keepMounted>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <div className="flex items-center">
                <IconBackhoe className="h-6 w-6 text-green-600 mr-2" />
                <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                  Support Channels (All Agencies)
                </h2>
              </div>
              <div className="flex items-center gap-2">
                {supportChannels.length > 0 && Object.keys(buildFolderTree(supportChannels, folderSeparator, 'name').folders).length > 0 && (
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => expandAllFolders(supportChannels)}
                      className="inline-flex items-center px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
                    >
                      <ChevronDownIcon className="h-4 w-4 mr-1" />
                      Expand All
                    </button>
                    <button
                      onClick={collapseAllFolders}
                      className="inline-flex items-center px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
                    >
                      <ChevronUpIcon className="h-4 w-4 mr-1" />
                      Collapse All
                    </button>
                  </div>
                )}
                {isGlobalManager && (
                  <button
                    onClick={() => {
                      setCreateType('support');
                      setShowCreateModal(true);
                    }}
                    className="btn-primary flex items-center justify-center"
                  >
                    <PlusIcon className="h-4 w-4 mr-2 flex-shrink-0" />
                    Create Support Channel
                  </button>
                )}
              </div>
            </div>

            {supportChannels.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400">No support channels configured.</p>
            ) : (
              <div className="space-y-3">
                {renderFolderTree(buildFolderTree(supportChannels, folderSeparator, 'name'), '', 'support')}
              </div>
            )}
          </TabPanel>

          {/* XtraTools Channels */}
          <TabPanel id="utl" activeTab={activeChannelTab} keepMounted>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <div className="flex items-center">
                <IconTool className="h-6 w-6 text-purple-600 mr-2" />
                <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                  XtraTools Channels
                </h2>
              </div>
              <div className="flex items-center gap-2">
                {utlChannels.length > 0 && Object.keys(buildFolderTree(utlChannels, folderSeparator, 'name').folders).length > 0 && (
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => expandAllFolders(utlChannels)}
                      className="inline-flex items-center px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
                    >
                      <ChevronDownIcon className="h-4 w-4 mr-1" />
                      Expand All
                    </button>
                    <button
                      onClick={collapseAllFolders}
                      className="inline-flex items-center px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
                    >
                      <ChevronUpIcon className="h-4 w-4 mr-1" />
                      Collapse All
                    </button>
                  </div>
                )}
                {isGlobalManager && (
                  <button
                    onClick={() => {
                      setCreateType('utl');
                      setShowCreateModal(true);
                    }}
                    className="btn-primary flex items-center justify-center"
                  >
                    <PlusIcon className="h-4 w-4 mr-2 flex-shrink-0" />
                    Create XtraTools Channel
                  </button>
                )}
              </div>
            </div>

            {utlChannels.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400">No XtraTools channels configured.</p>
            ) : (
              <div className="space-y-3">
                {renderFolderTree(buildFolderTree(utlChannels, folderSeparator, 'name'), '', 'utl')}
              </div>
            )}
          </TabPanel>
        </div>
      </div>

      {/* Global Channel Management -- moved below the tabs per explicit
          request, so the page reads: what channels exist (tabs), then
          bulk operations that act on/across all of them. */}
      {isGlobalManager && (
        <div className="card">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
            Global Channel Management
          </h3>
          {/* Bugfix: same stack-below-`sm:` fix as the header buttons above
              -- three actions in a non-wrapping `space-x-3` row previously
              had no way to stay tappable on a narrow phone. */}
          <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3 mb-4">
            <button
              onClick={handleSyncChannels}
              disabled={syncingChannels}
              className="btn-secondary flex items-center justify-center"
            >
              {syncingChannels ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2"></div>
              ) : (
                <GlobeAltIcon className="h-4 w-4 mr-2" />
              )}
              {syncingChannels ? 'Syncing...' : 'Sync Existing Channels'}
            </button>
            <button
              onClick={() => setShowAssignDialog(true)}
              className="btn-primary"
            >
              Assign All Users to Global Channels
            </button>
            {/* Bugfix: hidden once the standard set is fully seeded --
                `regionSeedComplete === true` is the ONLY state that hides
                it; `null` (status not yet loaded, or the check itself
                failed) and `false` both leave it shown. */}
            {regionSeedComplete !== true && (
              <button
                onClick={() => setShowSeedDialog(true)}
                className="btn-secondary"
              >
                Seed Standard Region Channels
              </button>
            )}
          </div>
          <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
            <p>• <strong>Sync Existing Channels:</strong> Import BCH, Response and Support channels that already exist in Authentik</p>
            <p>• <strong>Assign All Users:</strong> Ensure all existing users are added to all active global channels</p>
            {regionSeedComplete !== true && (
              <p>• <strong>Seed Standard Region Channels:</strong> Create the standard set of Response/Support channels for every NZ region, Chatham Islands, and All of New Zealand (support only) -- safe to run again, only fills in any missing channels</p>
            )}
          </div>
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        // Bugfix: `p-4` on the overlay (was missing entirely, unlike every
        // other dialog on this page) so the card doesn't sit flush against
        // the screen edges on a phone -- matching the Assign/Seed/Delete
        // confirmation dialogs' own outer padding below. This is a
        // 2-field form (Name, Description), the same size class as this
        // app's "plain tier" confirm dialogs rather than the larger
        // multi-field ones that get the full-bleed `w-full h-full sm:...`
        // treatment (Create User, Transfer, Suspend), so a fixed
        // `max-w-md` card with edge padding is the appropriate fix here.
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-global-channel-title"
            className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md"
          >
            <h3 id="create-global-channel-title" className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
              Create {CHANNEL_TYPE_META[createType].label} Channel
            </h3>
            
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Name
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="input"
                  required
                />
              </div>
              
              
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Description
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="input"
                  rows={3}
                />
              </div>
              
              <div className="flex justify-end space-x-2 pt-4">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="btn-secondary"
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Create Channel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Modal. Bugfix: same `p-4` overlay-padding fix as Create above. */}
      {showEditModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-global-channel-title"
            className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md"
          >
            <h3 id="edit-global-channel-title" className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
              Edit {editChannel ? CHANNEL_TYPE_META[editChannel.type].label : ''} Channel
            </h3>
            
            <form onSubmit={handleUpdate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Name
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="input"
                  required
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Description
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="input"
                  rows={3}
                />
              </div>
              
              <div className="flex justify-end space-x-2 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowEditModal(false);
                    setEditChannel(null);
                    setFormData({ name: '', description: '' });
                  }}
                  className="btn-secondary"
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Update Channel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Assign All Users Confirmation Dialog */}
      {showAssignDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="assign-all-users-title"
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full"
          >
            <div className="p-6">
              <h3 id="assign-all-users-title" className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                Assign All Users to Global Channels
              </h3>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                This will assign all users to global channels. Continue?
              </p>
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => setShowAssignDialog(false)}
                  className="btn-secondary"
                  disabled={assigningUsers}
                >
                  Cancel
                </button>
                <button
                  onClick={handleAssignAllUsers}
                  disabled={assigningUsers}
                  className="btn-primary"
                >
                  {assigningUsers ? 'Assigning...' : 'Assign Users'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Seed Standard Region Channels Confirmation Dialog */}
      {showSeedDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="seed-regions-title"
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full"
          >
            <div className="p-6">
              <h3 id="seed-regions-title" className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                Seed Standard Region Channels
              </h3>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                This will create up to 35 Response/Support channels (every NZ region, Chatham Islands, and All of New Zealand support-only) that don't already exist. Existing channels are left unchanged. Continue?
              </p>
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => setShowSeedDialog(false)}
                  className="btn-secondary"
                  disabled={seedingRegions}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSeedRegions}
                  disabled={seedingRegions}
                  className="btn-primary"
                >
                  {seedingRegions ? 'Seeding...' : 'Seed Channels'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {deleteChannel && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-global-channel-title"
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full"
          >
            <div className="p-6">
              <h3 id="delete-global-channel-title" className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                Delete {CHANNEL_TYPE_META[deleteChannel.type].label} Channel
              </h3>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                Are you sure you want to delete the {deleteChannel.type} channel "{deleteChannel.name}"? This action cannot be undone.
              </p>
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => setDeleteChannel(null)}
                  className="btn-secondary"
                  disabled={deletingChannel}
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDelete}
                  disabled={deletingChannel}
                  className="btn-danger disabled:opacity-50"
                >
                  {deletingChannel ? 'Deleting...' : 'Delete Channel'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bugfix ("Get credentials" button): the lite credentials view.
          Cycle Password / Delete Service Account open the shared confirm
          dialog below (rendered AFTER this one in the JSX so it stacks
          visually on top, both being fixed inset-0 z-50 overlays). */}
      {credentialsDialog && (
        <BchChannelCredentialsDialog
          channelName={credentialsDialog.channelName}
          credentials={credentialsDialog.credentials}
          onClose={() => setCredentialsDialog(null)}
          onRotateRequested={(username) => handleServiceAccountAction('rotate', username)}
          onDeleteRequested={(username) => handleServiceAccountAction('delete', username)}
        />
      )}

      {/* Bugfix (explicit request: "Add Service Account" modal). */}
      {addServiceAccountChannel && (
        <AddServiceAccountDialog
          channelId={addServiceAccountChannel.id}
          channelName={addServiceAccountChannel.name}
          onClose={() => setAddServiceAccountChannel(null)}
          onCompleted={fetchChannels}
        />
      )}

      {/* Bugfix (explicit request: cycle password / delete service
          account, both write-in confirmed). Closes the credentials
          dialog too on success -- a rotation invalidates the password it
          was showing, and a deletion removes the account it was showing
          entirely, so leaving that dialog open afterwards would display
          a stale/nonexistent credential. */}
      {serviceAccountAction && (
        <ServiceAccountActionConfirmDialog
          mode={serviceAccountAction.mode}
          channelId={serviceAccountAction.channelId}
          channelName={serviceAccountAction.channelName}
          serviceAccountUsername={serviceAccountAction.serviceAccountUsername}
          onClose={() => setServiceAccountAction(null)}
          onCompleted={() => {
            setCredentialsDialog(null);
            fetchChannels();
          }}
        />
      )}
    </div>
  );
}