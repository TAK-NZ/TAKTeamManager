import { useState, useEffect } from 'react';
import { PlusIcon, KeyIcon, GlobeAltIcon, RadioIcon } from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';
import { globalChannelsAPI } from '../services/api';

export default function GlobalChannels({ user }) {
  const [bchChannels, setBchChannels] = useState([]);
  const [regionChannels, setRegionChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createType, setCreateType] = useState('bch');
  const [formData, setFormData] = useState({
    name: '',
    display_name: '',
    description: ''
  });

  const isGlobalManager = user?.is_global_manager; // Global managers only

  useEffect(() => {
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
      setFormData({ name: '', display_name: '', description: '' });
      fetchChannels();
    } catch (error) {
      toast.error(`Failed to create ${createType} channel`);
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

  const handleAssignAllUsers = async () => {
    if (!confirm('This will assign all users to global channels. Continue?')) return;
    
    try {
      const response = await globalChannelsAPI.assignAllUsers();
      toast.success(`Assignment queued for ${response.data.usersProcessed} users`);
    } catch (error) {
      toast.error('Failed to assign users to global channels');
    }
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
          <button
            onClick={handleAssignAllUsers}
            className="btn-primary"
          >
            Assign All Users to Global Channels
          </button>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">
            This will ensure all existing users are added to all active global channels.
          </p>
        </div>
      )}

      {/* BCH Channels */}
      <div className="card">
        <div className="flex items-center mb-4">
          <RadioIcon className="h-6 w-6 text-blue-600 mr-2" />
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            BCH Channels (Broadcast/ETL)
          </h2>
        </div>
        
        {bchChannels.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400">No BCH channels configured.</p>
        ) : (
          <div className="space-y-3">
            {bchChannels.map((channel) => (
              <div key={channel.id} className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="font-medium text-gray-900 dark:text-gray-100">
                      {channel.display_name}
                    </h3>
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      {channel.description}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
                      Created by {channel.created_by_name} • Service Account: {channel.service_account_username}
                    </p>
                  </div>
                  
                  {isGlobalManager && (
                    <button
                      onClick={() => handleGetCredentials(channel.id)}
                      className="flex items-center text-sm text-blue-600 hover:text-blue-700"
                    >
                      <KeyIcon className="h-4 w-4 mr-1" />
                      Get Credentials
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Region Channels */}
      <div className="card">
        <div className="flex items-center mb-4">
          <GlobeAltIcon className="h-6 w-6 text-green-600 mr-2" />
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Region Channels
          </h2>
        </div>
        
        {regionChannels.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400">No region channels configured.</p>
        ) : (
          <div className="space-y-3">
            {regionChannels.map((channel) => (
              <div key={channel.id} className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <h3 className="font-medium text-gray-900 dark:text-gray-100">
                  {channel.display_name}
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {channel.description}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
                  Created by {channel.created_by_name}
                </p>
              </div>
            ))}
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
                  Display Name
                </label>
                <input
                  type="text"
                  value={formData.display_name}
                  onChange={(e) => setFormData({ ...formData, display_name: e.target.value })}
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
    </div>
  );
}