import { useState, useEffect } from 'react';
import { PlusIcon, KeyIcon, GlobeAltIcon, RadioIcon, PencilIcon, TrashIcon, FolderIcon, FolderOpenIcon, ChevronRightIcon, ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';
import { globalChannelsAPI, configAPI } from '../services/api';
import { buildFolderTree } from '../utils/channelTree';

export default function GlobalChannels({ user }) {
  const [bchChannels, setBchChannels] = useState([]);
  const [regionChannels, setRegionChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [createType, setCreateType] = useState('bch');
  const [editChannel, setEditChannel] = useState(null);
  const [deleteChannel, setDeleteChannel] = useState(null);
  const [deletingChannel, setDeletingChannel] = useState(false);
  const [showAssignDialog, setShowAssignDialog] = useState(false);
  const [assigningUsers, setAssigningUsers] = useState(false);
  const [syncingChannels, setSyncingChannels] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState(new Set());
  const [folderSeparator, setFolderSeparator] = useState(' - ');
  const [formData, setFormData] = useState({
    name: '',
    description: ''
  });

  const isGlobalManager = user?.is_global_manager; // Global managers only

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

  const handleCreate = async (e) => {
    e.preventDefault();
    
    try {
      if (createType === 'bch') {
        await globalChannelsAPI.createBchChannel(formData);
        toast.success('BCH channel created successfully');
      } else {
        await globalChannelsAPI.createRegionChannel(formData);
        toast.success('Region channel created successfully');
      }
      
      setShowCreateModal(false);
      setFormData({ name: '', description: '' });
      fetchChannels();
    } catch (error) {
      toast.error(`Failed to create ${createType} channel`);
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
      if (editChannel.type === 'bch') {
        await globalChannelsAPI.updateBchChannel(editChannel.id, formData);
        toast.success('BCH channel updated successfully');
      } else {
        await globalChannelsAPI.updateRegionChannel(editChannel.id, formData);
        toast.success('Region channel updated successfully');
      }
      
      setShowEditModal(false);
      setEditChannel(null);
      setFormData({ name: '', description: '' });
      fetchChannels();
    } catch (error) {
      toast.error(`Failed to update ${editChannel.type} channel`);
    }
  };

  const handleDelete = (channelId, channelType, channelName) => {
    setDeleteChannel({ id: channelId, type: channelType, name: channelName });
  };

  const confirmDelete = async () => {
    if (!deleteChannel) return;
    
    setDeletingChannel(true);
    try {
      await globalChannelsAPI.deleteChannel(deleteChannel.type, deleteChannel.id);
      toast.success(`${deleteChannel.type.toUpperCase()} channel deleted successfully`);
      fetchChannels();
      setDeleteChannel(null);
    } catch (error) {
      toast.error(`Failed to delete ${deleteChannel.type} channel`);
    } finally {
      setDeletingChannel(false);
    }
  };

  const handleGetCredentials = async (channelId) => {
    try {
      const response = await globalChannelsAPI.getBchCredentials(channelId);
      const { credentials } = response.data;
      
      // Show credentials in a modal or copy to clipboard
      navigator.clipboard.writeText(`Username: ${credentials.service_account_username}\nPassword: ${credentials.service_account_password}`);
      toast.success('Credentials copied to clipboard');
    } catch (error) {
      toast.error('Failed to get credentials');
    }
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
            className="flex items-center p-3 bg-gray-100 dark:bg-gray-800 rounded-lg cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-700"
            onClick={() => toggleFolder(folderPath)}
          >
            <div className="flex items-center flex-1">
              {isExpanded ? (
                <FolderOpenIcon className="h-5 w-5 text-blue-600 dark:text-blue-400 mr-2" />
              ) : (
                <FolderIcon className="h-5 w-5 text-blue-600 dark:text-blue-400 mr-2" />
              )}
              <span className="font-medium text-gray-900 dark:text-gray-100">{folderName}</span>
            </div>
            <ChevronRightIcon className={`h-4 w-4 text-gray-500 dark:text-gray-300 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
          </div>
        </div>
      );
      
      if (isExpanded) {
        items.push(
          <div key={`${folderPath}-children`} className="ml-6 mt-2 space-y-2">
            {renderFolderTree(subtree, folderPath, channelType)}
          </div>
        );
      }
    });
    
    // Render channels
    tree.channels.forEach(channel => {
      items.push(
        <div key={channel.id} className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 ml-6">
          <div className="flex justify-between items-start">
            <div>
              <h3 className="font-medium text-gray-900 dark:text-gray-100">
                {channel.name}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {channel.description}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
                Created by {channel.created_by_name}
                {channelType === 'bch' && channel.service_account_username && (
                  <> • Service Account: {channel.service_account_username}</>
                )}
              </p>
            </div>
            
            {isGlobalManager && (
              <div className="flex items-center space-x-3">
                {channelType === 'bch' && (
                  <button
                    onClick={() => handleGetCredentials(channel.id)}
                    className="text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
                    title="Get credentials"
                  >
                    <KeyIcon className="h-4 w-4" />
                  </button>
                )}
                <button
                  onClick={() => handleEdit(channel, channelType)}
                  className="text-gray-600 hover:text-gray-500 dark:text-gray-400 dark:hover:text-gray-300"
                  title="Edit channel"
                >
                  <PencilIcon className="h-4 w-4" />
                </button>
                <button
                  onClick={() => handleDelete(channel.id, channelType, channel.name)}
                  className="text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300"
                  title="Delete channel"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
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
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Global Channels</h1>
          <p className="text-gray-600 dark:text-gray-400">
            Manage BCH (broadcast/ETL) and Region channels that all users have access to.
          </p>
        </div>
        
        {isGlobalManager && (
          <div className="flex space-x-2">
            <button
              onClick={() => {
                setCreateType('bch');
                setShowCreateModal(true);
              }}
              className="btn-primary flex items-center"
            >
              <PlusIcon className="h-4 w-4 mr-2" />
              Create BCH Channel
            </button>
            <button
              onClick={() => {
                setCreateType('region');
                setShowCreateModal(true);
              }}
              className="btn-secondary flex items-center"
            >
              <PlusIcon className="h-4 w-4 mr-2" />
              Create Region Channel
            </button>
          </div>
        )}
      </div>

      {isGlobalManager && (
        <div className="card">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
            Global Channel Management
          </h3>
          <div className="flex space-x-3 mb-4">
            <button
              onClick={handleSyncChannels}
              disabled={syncingChannels}
              className="btn-secondary flex items-center"
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
          </div>
          <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
            <p>• <strong>Sync Existing Channels:</strong> Import BCH and Region channels that already exist in Authentik</p>
            <p>• <strong>Assign All Users:</strong> Ensure all existing users are added to all active global channels</p>
          </div>
        </div>
      )}

      {/* BCH Channels */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center">
            <RadioIcon className="h-6 w-6 text-blue-600 mr-2" />
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              BCH Channels (Broadcast/ETL)
            </h2>
          </div>
          {bchChannels.length > 0 && Object.keys(buildFolderTree(bchChannels, folderSeparator, 'name').folders).length > 0 && (
            <div className="flex items-center space-x-2">
              <button
                onClick={() => expandAllFolders(bchChannels)}
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
        </div>
        
        {bchChannels.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400">No BCH channels configured.</p>
        ) : (
          <div className="space-y-3">
            {renderFolderTree(buildFolderTree(bchChannels, folderSeparator, 'name'), '', 'bch')}
          </div>
        )}
      </div>

      {/* Region Channels */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center">
            <GlobeAltIcon className="h-6 w-6 text-green-600 mr-2" />
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              Region Channels
            </h2>
          </div>
          {regionChannels.length > 0 && Object.keys(buildFolderTree(regionChannels, folderSeparator, 'name').folders).length > 0 && (
            <div className="flex items-center space-x-2">
              <button
                onClick={() => expandAllFolders(regionChannels)}
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
        </div>
        
        {regionChannels.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400">No region channels configured.</p>
        ) : (
          <div className="space-y-3">
            {renderFolderTree(buildFolderTree(regionChannels, folderSeparator, 'name'), '', 'region')}
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
              Create {createType === 'bch' ? 'BCH' : 'Region'} Channel
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

      {/* Edit Modal */}
      {showEditModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
              Edit {editChannel?.type === 'bch' ? 'BCH' : 'Region'} Channel
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
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full">
            <div className="p-6">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
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

      {/* Delete Confirmation Dialog */}
      {deleteChannel && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full">
            <div className="p-6">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                Delete {deleteChannel.type === 'bch' ? 'BCH' : 'Region'} Channel
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
                  className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50"
                >
                  {deletingChannel ? 'Deleting...' : 'Delete Channel'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}