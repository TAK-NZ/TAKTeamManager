import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { requestsAPI } from '../services/api'
import { ThemeProvider } from '../contexts/ThemeContext'

export default function RequestAccess() {
  const [submitted, setSubmitted] = useState(false)
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm()

  const onSubmit = async (data) => {
    try {
      await requestsAPI.submitTeamAccess(data)
      setSubmitted(true)
      toast.success('Access request submitted successfully!')
    } catch (error) {
      toast.error('Failed to submit request. Please try again.')
    }
  }

  if (submitted) {
    return (
      <ThemeProvider>
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4">
          <div className="max-w-md w-full">
            <div className="card text-center">
              <div className="w-16 h-16 mx-auto mb-4 bg-green-100 dark:bg-green-900 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">Request Submitted</h2>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                Your team access request has been submitted. A team administrator will review your request and contact you via email.
              </p>
              <Link to="/" className="btn-primary">
                Back to Login
              </Link>
            </div>
          </div>
        </div>
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider>
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4">
        <div className="max-w-md w-full">
          <div className="card">
            <div className="text-center mb-6">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Request Team Access</h2>
              <p className="text-gray-600 dark:text-gray-400 mt-2">
                Fill out this form to request access to a TAK team
              </p>
            </div>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Email Address
              </label>
              <input
                type="email"
                className="input"
                {...register('email', { required: 'Email is required' })}
              />
              {errors.email && (
                <p className="text-red-600 text-sm mt-1">{errors.email.message}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  First Name
                </label>
                <input
                  type="text"
                  className="input"
                  {...register('firstName', { required: 'First name is required' })}
                />
                {errors.firstName && (
                  <p className="text-red-600 text-sm mt-1">{errors.firstName.message}</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Last Name
                </label>
                <input
                  type="text"
                  className="input"
                  {...register('lastName', { required: 'Last name is required' })}
                />
                {errors.lastName && (
                  <p className="text-red-600 text-sm mt-1">{errors.lastName.message}</p>
                )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Team Name
              </label>
              <input
                type="text"
                className="input"
                placeholder="e.g., Fire Department, Police, Emergency Services"
                {...register('teamName', { required: 'Team name is required' })}
              />
              {errors.teamName && (
                <p className="text-red-600 text-sm mt-1">{errors.teamName.message}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Reason for Access
              </label>
              <textarea
                rows={4}
                className="input"
                placeholder="Please explain why you need access to this team..."
                {...register('reason', { 
                  required: 'Reason is required',
                  minLength: { value: 10, message: 'Please provide more detail (minimum 10 characters)' }
                })}
              />
              {errors.reason && (
                <p className="text-red-600 text-sm mt-1">{errors.reason.message}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full btn-primary disabled:opacity-50"
            >
              {isSubmitting ? 'Submitting...' : 'Submit Request'}
            </button>
          </form>

          <div className="text-center mt-6">
            <Link to="/" className="text-sm text-primary-600 hover:text-primary-500">
              Already have an account? Sign in
            </Link>
          </div>
          </div>
        </div>
      </div>
    </ThemeProvider>
  )
}