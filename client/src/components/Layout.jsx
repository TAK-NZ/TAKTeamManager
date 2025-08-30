import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { 
  HomeIcon, 
  UserGroupIcon, 
  UsersIcon, 
  ClipboardDocumentListIcon,
  Bars3Icon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import { authAPI } from '../services/api'

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: HomeIcon },
  { name: 'Teams', href: '/teams', icon: UserGroupIcon },
  { name: 'Users', href: '/users', icon: UsersIcon },
  { name: 'Requests', href: '/requests', icon: ClipboardDocumentListIcon },
]

export default function Layout({ children, user }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const location = useLocation()

  const handleLogout = async () => {
    try {
      await authAPI.logout()
    } finally {
      localStorage.removeItem('token')
      window.location.href = '/login'
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Mobile sidebar */}
      <div className={`fixed inset-0 z-50 lg:hidden ${sidebarOpen ? '' : 'hidden'}`}>
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75" onClick={() => setSidebarOpen(false)} />
        <div className="fixed inset-y-0 left-0 flex w-64 flex-col bg-white">
          <div className="flex h-16 items-center justify-between py-4">
            <img 
              src="https://raw.githubusercontent.com/TAK-NZ/auth-infra/refs/heads/main/authentik/branding/icons/tak-nz-brand-wide.svg" 
              alt="TAK.NZ" 
              className="h-10 w-auto"
            />
            <button onClick={() => setSidebarOpen(false)}>
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>
          <nav className="flex-1 space-y-1 px-2 py-4">
            {navigation.map((item) => (
              <Link
                key={item.name}
                to={item.href}
                className={`group flex items-center px-2 py-2 text-sm font-medium rounded-md ${
                  location.pathname === item.href
                    ? 'bg-primary-100 text-primary-700'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
                onClick={() => setSidebarOpen(false)}
              >
                <item.icon className="mr-3 h-6 w-6" />
                {item.name}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      {/* Desktop sidebar */}
      <div className="hidden lg:fixed lg:inset-y-0 lg:flex lg:w-64 lg:flex-col">
        <div className="flex flex-col flex-grow bg-white border-r border-gray-200">
          <div className="flex h-16 items-center py-4">
            <img 
              src="https://raw.githubusercontent.com/TAK-NZ/auth-infra/refs/heads/main/authentik/branding/icons/tak-nz-brand-wide.svg" 
              alt="TAK.NZ" 
              className="h-10 w-auto"
            />
          </div>
          <nav className="flex-1 space-y-1 px-2 py-4">
            {navigation.map((item) => (
              <Link
                key={item.name}
                to={item.href}
                className={`group flex items-center px-2 py-2 text-sm font-medium rounded-md ${
                  location.pathname === item.href
                    ? 'bg-primary-100 text-primary-700'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <item.icon className="mr-3 h-6 w-6" />
                {item.name}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      {/* Main content */}
      <div className="lg:pl-64">
        {/* Top bar */}
        <div className="sticky top-0 z-40 flex h-16 bg-white shadow">
          <button
            className="px-4 text-gray-500 lg:hidden"
            onClick={() => setSidebarOpen(true)}
          >
            <Bars3Icon className="h-6 w-6" />
          </button>
          <div className="flex flex-1 justify-between items-center px-4">
            <h1 className="text-xl font-bold text-gray-900">TAK Team Manager</h1>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-700">
                {user?.first_name} {user?.last_name}
              </span>
              <button
                onClick={handleLogout}
                className="px-3 py-1 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50 hover:border-gray-400"
              >
                Logout
              </button>
            </div>
          </div>
        </div>

        {/* Page content */}
        <main className="py-6">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}