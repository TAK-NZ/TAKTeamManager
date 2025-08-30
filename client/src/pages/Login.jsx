import { Link } from 'react-router-dom'
import { authAPI } from '../services/api'

export default function Login() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <img
            className="mx-auto h-40 w-auto"
            src="https://raw.githubusercontent.com/TAK-NZ/auth-infra/refs/heads/main/authentik/branding/icons/tak-nz-brand-tall.svg"
            alt="TAK.NZ"
          />
          <h2 className="mt-6 text-center text-3xl font-bold text-gray-900">
            TAK Team Manager
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Manage your TAK teams and channels
          </p>
        </div>
        <div className="space-y-4">
          <button
            onClick={authAPI.login}
            className="group relative w-full flex justify-center py-3 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
          >
            Sign in
          </button>
          
          <div className="text-center">
            <span className="text-sm text-gray-500">Don't have an account?</span>
            <Link
              to="/request-access"
              className="ml-2 text-sm text-primary-600 hover:text-primary-500"
            >
              Request an account
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}