import { useState, useEffect } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import DOMPurify from 'dompurify'
import { requestsAPI, teamsAPI, configAPI } from '../services/api'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ChevronDownIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { DOMPURIFY_OPTIONS } from '../utils/htmlSafeSubset'
import { getRecaptchaToken } from '../utils/recaptcha'

// Must exactly match RECAPTCHA_EXPECTED_ACTION in server/middleware/captcha.js
// -- reCAPTCHA v3 scopes each generated token to the action it was minted
// for, and the server rejects a token whose action does not match.
const RECAPTCHA_ACTION = 'team_access_request'

export default function RequestAccess() {
  const [submitted, setSubmitted] = useState(false)
  const [teams, setTeams] = useState([])
  const [filteredTeams, setFilteredTeams] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const [selectedTeam, setSelectedTeam] = useState(null)
  const [config, setConfig] = useState({
    request_access_title: 'Request Team Access',
    request_access_subtitle: 'Fill out this form to request access to a TAK team',
    request_access_footer: ''
  })
  const { register, handleSubmit, control, formState: { errors, isSubmitting } } = useForm()

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [teamsResponse, configResponse] = await Promise.all([
          teamsAPI.getJoinable(),
          configAPI.getPublic()
        ])
        setTeams(teamsResponse.data.teams || [])
        setFilteredTeams(teamsResponse.data.teams || [])
        setConfig(configResponse.data)
      } catch (error) {
        console.error('Failed to fetch data:', error)
        toast.error('Failed to load page data')
      }
    }
    fetchData()
  }, [])

  useEffect(() => {
    if (!Array.isArray(teams)) return
    const filtered = teams.filter(team => 
      team.display_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      team.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (team.description && team.description.toLowerCase().includes(searchTerm.toLowerCase()))
    )
    setFilteredTeams(filtered)
  }, [searchTerm, teams])

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!event.target.closest('.team-dropdown')) {
        setIsDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const onSubmit = async (data) => {
    try {
      let recaptchaToken

      // config.recaptcha_disabled mirrors the server's own
      // RECAPTCHA_DISABLED bypass (non-production only -- see
      // server/middleware/captcha.js's isRecaptchaDisabledForTesting).
      // When active, the server won't call Google's verify API at all,
      // so there's no point loading the script / generating a token
      // here either -- and doing so would otherwise block the form on a
      // missing site key.
      if (!config.recaptcha_disabled) {
        if (!config.recaptcha_site_key) {
          toast.error('CAPTCHA is not configured. Please contact an administrator.')
          return
        }
        recaptchaToken = await getRecaptchaToken(config.recaptcha_site_key, RECAPTCHA_ACTION)
      }

      const submitData = {
        ...data,
        teamId: selectedTeam?.id,
        teamName: selectedTeam?.name,
        'g-recaptcha-response': recaptchaToken
      }
      await requestsAPI.submitTeamAccess(submitData)
      setSubmitted(true)
      toast.success('Access request submitted successfully!')
    } catch (error) {
      // Surface the server's specific rejection reason (e.g. the
      // improved CAPTCHA failure messages from server/middleware/
      // captcha.js) instead of a generic message, when one is available.
      const serverMessage = error.response?.data?.error
      toast.error(serverMessage || 'Failed to submit request. Please try again.')
    }
  }

  const handleTeamSelect = (team) => {
    setSelectedTeam(team)
    setSearchTerm(team.display_name || team.name)
    setIsDropdownOpen(false)
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
              {config.authentik_origin ? (
                <a href={config.authentik_origin} className="btn-primary">
                  Back to Login
                </a>
              ) : (
                <Link to="/" className="btn-primary">
                  Back to Login
                </Link>
              )}
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
              <img
                className="mx-auto h-32 w-auto mb-4"
                src="/assets/tak-nz-brand-tall.svg"
                alt="TAK.NZ"
              />
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{config.request_access_title}</h2>
              <p className="text-gray-600 dark:text-gray-400 mt-2">
                {config.request_access_subtitle}
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
                Select Team
              </label>
              <Controller
                name="teamId"
                control={control}
                rules={{ required: 'Please select a team' }}
                render={({ field }) => (
                  <div className="relative team-dropdown">
                    <div className="relative">
                      <input
                        type="text"
                        className="input pr-10"
                        placeholder="Search for a team..."
                        value={searchTerm}
                        onChange={(e) => {
                          setSearchTerm(e.target.value)
                          setIsDropdownOpen(true)
                          if (!e.target.value) setSelectedTeam(null)
                        }}
                        onFocus={() => setIsDropdownOpen(true)}
                      />
                      <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
                        <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
                      </div>
                    </div>
                    
                    {isDropdownOpen && filteredTeams.length > 0 && (
                      <div className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg max-h-60 overflow-auto">
                        {filteredTeams.map((team) => (
                          <div
                            key={team.id}
                            className="px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
                            onClick={() => {
                              handleTeamSelect(team)
                              field.onChange(team.id)
                            }}
                          >
                            <div className="font-medium text-gray-900 dark:text-gray-100">
                              {team.display_name || team.name}
                            </div>
                            {team.description && (
                              <div className="text-sm text-gray-500 dark:text-gray-400 truncate">
                                {team.description}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    
                    {isDropdownOpen && filteredTeams.length === 0 && searchTerm && (
                      <div className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg">
                        <div className="px-4 py-2 text-gray-500 dark:text-gray-400">
                          No teams found matching "{searchTerm}"
                        </div>
                      </div>
                    )}
                  </div>
                )}
              />
              {errors.teamId && (
                <p className="text-red-600 text-sm mt-1">{errors.teamId.message}</p>
              )}
              {!selectedTeam && searchTerm && (
                <p className="text-amber-600 text-sm mt-1">Please select a team from the dropdown</p>
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
              disabled={isSubmitting || !selectedTeam}
              className="w-full btn-primary disabled:opacity-50"
            >
              {isSubmitting ? 'Submitting...' : 'Submit Request'}
            </button>
          </form>

          {config.request_access_footer && (
            <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
              <div 
                className="text-sm text-blue-800 dark:text-blue-200"
                dangerouslySetInnerHTML={{
                  __html: typeof config.request_access_footer === 'string'
                    ? DOMPurify.sanitize(config.request_access_footer, DOMPURIFY_OPTIONS)
                    : ''
                }}
              />
            </div>
          )}

          <div className="text-center mt-6">
            {config.authentik_origin ? (
              <a
                href={config.authentik_origin}
                className="text-sm text-primary-600 hover:text-primary-500"
              >
                Already have an account? Sign in
              </a>
            ) : (
              <Link to="/" className="text-sm text-primary-600 hover:text-primary-500">
                Already have an account? Sign in
              </Link>
            )}
          </div>
          </div>
        </div>
      </div>
    </ThemeProvider>
  )
}