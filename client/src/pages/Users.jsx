import { useState } from 'react'
import { PlusIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline'

export default function Users() {
  const [searchQuery, setSearchQuery] = useState('')

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Users</h1>
          <p className="text-gray-600">Manage users and their team assignments.</p>
        </div>
        <button className="btn-primary flex items-center">
          <PlusIcon className="h-5 w-5 mr-2" />
          Create User
        </button>
      </div>

      {/* Search */}
      <div className="card">
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search users by name, email, or username..."
            className="input pl-10"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Users List */}
      <div className="card">
        <div className="text-center py-12">
          <p className="text-gray-500">Search for users to manage their team assignments.</p>
        </div>
      </div>
    </div>
  )
}