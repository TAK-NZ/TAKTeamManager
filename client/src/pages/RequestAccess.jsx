import { useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import DOMPurify from 'dompurify'
import { signupAPI, configAPI } from '../services/api'
import { ThemeProvider } from '../contexts/ThemeContext'
import { DOMPURIFY_OPTIONS } from '../utils/htmlSafeSubset'
import { getRecaptchaToken } from '../utils/recaptcha'

// Must exactly match RECAPTCHA_EXPECTED_ACTION in server/middleware/captcha.js
const RECAPTCHA_ACTION = 'team_access_request'

// The valid charset for sign-up codes (30 chars, no ambiguous 0/O/1/I/L)
const VALID_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

// Client-side code format validation: 8 chars from valid set, optional dash
// after first 4 (e.g. "ABCD-EFGH" or "ABCDEFGH")
export function isValidCodeFormat(input) {
  if (!input) return true // empty is valid (code is optional)
  const stripped = input.replace(/-/g, '').toUpperCase()
  if (stripped.length !== 8) return false
  return [...stripped].every(ch => VALID_CODE_CHARS.includes(ch))
}

// Requirement 11.9/11.10: pure helper deciding whether the "Preferred
// Callsign Suffix" input should render for a team. Retained for backward
// compatibility with existing tests and potential future use in the
// TeamSelectionStep.
export function shouldShowCallsignSuffixInput(team) {
  return team?.callsignNameFormat === 'user_defined'
}

// Steps in the sign-up state machine
const STEPS = {
  EMAIL: 'email',
  SUBMITTED: 'submitted',
  TEAM_SELECTION: 'team_selection',
  NO_TEAMS: 'no_teams',
  SUBMIT_SUCCESS: 'submit_success',
  ORG_INTEREST_SUBMITTED: 'org_interest_submitted',
  EXPIRED: 'expired',
  LOADING: 'loading',
}

export default function RequestAccess() {
  const [searchParams] = useSearchParams()
  const tokenParam = searchParams.get('token')
  const codeParam = searchParams.get('code')

  const [step, setStep] = useState(tokenParam ? STEPS.LOADING : STEPS.EMAIL)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState(codeParam || '')
  const [codeError, setCodeError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [config, setConfig] = useState({
    request_access_title: 'Request TAK.NZ Access',
    request_access_subtitle: 'Fill out this form to request access to a TAK.NZ team',
    request_access_footer: ''
  })

  // Team selection step state
  const [teams, setTeams] = useState([])
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [selectedTeamId, setSelectedTeamId] = useState('')
  const [codeTeamId, setCodeTeamId] = useState(null) // the team ID the sign-up code maps to
  const [reason, setReason] = useState('')
  const [tosAgreed, setTosAgreed] = useState(false)
  const [verifiedEmail, setVerifiedEmail] = useState('')

  // No teams / org interest state
  const [orgName, setOrgName] = useState('')

  useEffect(() => {
    configAPI.getPublic()
      .then(res => setConfig(res.data))
      .catch(err => console.error('Failed to fetch config:', err))
  }, [])

  // If we have a token param, fetch available teams on mount
  useEffect(() => {
    if (!tokenParam) return

    signupAPI.getAvailableTeams(tokenParam)
      .then(res => {
        const { teams: availableTeams, email: tokenEmail } = res.data
        setVerifiedEmail(tokenEmail || '')
        if (availableTeams && availableTeams.length > 0) {
          setTeams(availableTeams)
          // If a sign-up code was used, lock the team selection to that team
          if (res.data.codeTeamId) {
            setCodeTeamId(res.data.codeTeamId)
            setSelectedTeamId(String(res.data.codeTeamId))
          } else if (availableTeams.length === 1) {
            setSelectedTeamId(String(availableTeams[0].id))
          }
          setStep(STEPS.TEAM_SELECTION)
        } else {
          setStep(STEPS.NO_TEAMS)
        }
      })
      .catch(err => {
        if (err.response?.status === 410 || err.response?.status === 401) {
          setStep(STEPS.EXPIRED)
        } else {
          console.error('Failed to fetch available teams:', err)
          toast.error('Failed to load sign-up data')
          setStep(STEPS.EXPIRED)
        }
      })
  }, [tokenParam])

  const handleEmailSubmit = async (e) => {
    e.preventDefault()

    // Validate code format if provided
    if (code && !isValidCodeFormat(code)) {
      setCodeError('Invalid code format. Must be 8 characters (letters/digits, optional dash).')
      return
    }
    setCodeError('')
    setIsSubmitting(true)

    try {
      let recaptchaToken
      if (!config.recaptcha_disabled) {
        if (!config.recaptcha_site_key) {
          toast.error('CAPTCHA is not configured. Please contact an administrator.')
          setIsSubmitting(false)
          return
        }
        recaptchaToken = await getRecaptchaToken(config.recaptcha_site_key, RECAPTCHA_ACTION)
      }

      await signupAPI.initiate(email, code || undefined, recaptchaToken)
      setStep(STEPS.SUBMITTED)
    } catch (error) {
      const serverMessage = error.response?.data?.error
      toast.error(serverMessage || 'Failed to submit. Please try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleTeamAccessSubmit = async (e) => {
    e.preventDefault()
    if (!selectedTeamId || !firstName || !lastName || !reason || reason.length < 10) return

    setIsSubmitting(true)
    try {
      let recaptchaToken
      if (!config.recaptcha_disabled) {
        if (!config.recaptcha_site_key) {
          toast.error('CAPTCHA is not configured. Please contact an administrator.')
          setIsSubmitting(false)
          return
        }
        recaptchaToken = await getRecaptchaToken(config.recaptcha_site_key, RECAPTCHA_ACTION)
      }

      await signupAPI.submitTeamAccess({
        token: tokenParam,
        firstName,
        lastName,
        teamId: parseInt(selectedTeamId, 10),
        reason,
      }, recaptchaToken)
      setStep(STEPS.SUBMIT_SUCCESS)
    } catch (error) {
      const serverMessage = error.response?.data?.error
      toast.error(serverMessage || 'Failed to submit request. Please try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleOrgInterestSubmit = async (e) => {
    e.preventDefault()
    if (!firstName || !lastName || !orgName) return

    setIsSubmitting(true)
    try {
      await signupAPI.submitOrgInterest({
        token: tokenParam,
        firstName,
        lastName,
        orgName,
        email: verifiedEmail,
      })
      setStep(STEPS.ORG_INTEREST_SUBMITTED)
    } catch (error) {
      const serverMessage = error.response?.data?.error
      toast.error(serverMessage || 'Failed to submit. Please try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const renderStep = () => {
    switch (step) {
      case STEPS.LOADING:
        return (
          <div className="card text-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto mb-4"></div>
            <p className="text-gray-600 dark:text-gray-400">Loading...</p>
          </div>
        )

      case STEPS.EMAIL:
        return (
          <div className="card">
            <div className="text-center mb-6">
              <img
                className="mx-auto h-32 w-auto mb-4"
                src="/assets/tak-nz-logo.svg"
                alt="TAK.NZ"
              />
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{config.request_access_title}</h2>
              <p className="text-gray-600 dark:text-gray-400 mt-2">
                {config.request_access_subtitle}
              </p>
            </div>

            <form onSubmit={handleEmailSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Email Address
                </label>
                <input
                  type="email"
                  className="input w-full"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="you@organisation.nz"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Sign-up Code <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  className="input w-full"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value)
                    if (codeError) setCodeError('')
                  }}
                  placeholder="XXXX-XXXX"
                  maxLength={9}
                />
                {codeError && (
                  <p role="alert" className="text-red-600 dark:text-red-400 text-sm mt-1">{codeError}</p>
                )}
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  If you have a sign-up code from a team, enter it here to go directly to that team.
                </p>
              </div>

              <button
                type="submit"
                disabled={isSubmitting || !email}
                className="w-full btn-primary disabled:opacity-50"
              >
                {isSubmitting ? 'Submitting...' : 'Continue'}
              </button>
            </form>

            {config.request_access_footer && (
              <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
                <div
                  className="text-sm text-blue-800 dark:text-blue-200 [&_a]:underline [&_a]:text-blue-600 dark:[&_a]:text-blue-300 [&_a]:hover:text-blue-800 dark:[&_a]:hover:text-blue-100"
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
        )

      case STEPS.SUBMITTED:
        return (
          <div className="card text-center">
            <div className="w-16 h-16 mx-auto mb-4 bg-blue-100 dark:bg-blue-900 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">Check your email to continue</h2>
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              We've sent a verification link to your email address. Click the link to continue with your sign-up.
            </p>
            {config.authentik_origin ? (
              <a href={config.authentik_origin} className="text-sm text-primary-600 hover:text-primary-500">
                Return to TAK.NZ
              </a>
            ) : (
              <a href="/" className="text-sm text-primary-600 hover:text-primary-500">
                Return to TAK.NZ
              </a>
            )}
          </div>
        )

      case STEPS.TEAM_SELECTION:
        return (
          <div className="card">
            <div className="text-center mb-6">
              <img
                className="mx-auto h-32 w-auto mb-4"
                src="/assets/tak-nz-logo.svg"
                alt="TAK.NZ"
              />
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Complete Your Sign-up</h2>
              <p className="text-gray-600 dark:text-gray-400 mt-2">
                Your email has been verified. Please fill in your details below and select the team you'd like to join.
              </p>
            </div>

            <form onSubmit={handleTeamAccessSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    First Name
                  </label>
                  <input
                    type="text"
                    className="input w-full"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    required
                    placeholder="Joe"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Last Name
                  </label>
                  <input
                    type="text"
                    className="input w-full"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    required
                    placeholder="Bloggs"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Team
                </label>
                {codeTeamId ? (
                  <>
                    <div className="input w-full bg-gray-50 dark:bg-gray-700 flex items-center justify-between">
                      <span className="text-gray-900 dark:text-gray-100">
                        {teams.find(t => String(t.id) === String(codeTeamId))?.display_name || teams.find(t => String(t.id) === String(codeTeamId))?.name || 'Selected team'}
                      </span>
                      <span className="text-xs bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 px-2 py-0.5 rounded-full">
                        via sign-up code
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      This team was selected via your sign-up code.
                    </p>
                  </>
                ) : (
                  <>
                    <select
                      className="input w-full"
                      value={selectedTeamId}
                      onChange={(e) => setSelectedTeamId(e.target.value)}
                      required
                    >
                      <option value="">Select a team...</option>
                      {teams.map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.display_name || team.name}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      Select the team or organisation you would like to request access to.
                    </p>
                    <button
                      type="button"
                      onClick={() => setStep(STEPS.NO_TEAMS)}
                      className="text-sm text-primary-600 hover:text-primary-500 underline mt-1"
                    >
                      Can't find your team? Request a new team here.
                    </button>
                  </>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Reason for Access
                </label>
                <textarea
                  className="input w-full"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  required
                  rows={3}
                  minLength={10}
                  placeholder="Please explain why you need access to this team..."
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Briefly describe your role or why you need access (minimum 10 characters).
                </p>
              </div>

              {config.tos_url && (
                <div className="flex items-start">
                  <input
                    type="checkbox"
                    id="tosCheckbox"
                    checked={tosAgreed}
                    onChange={(e) => setTosAgreed(e.target.checked)}
                    className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded mt-0.5"
                  />
                  <label htmlFor="tosCheckbox" className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                    I agree to the{' '}
                    <a href={config.tos_url} target="_blank" rel="noopener noreferrer" className="text-primary-600 hover:text-primary-500 underline">
                      Terms of Service
                    </a>
                  </label>
                </div>
              )}

              <button
                type="submit"
                disabled={isSubmitting || !selectedTeamId || !firstName || !lastName || !reason || reason.length < 10 || (config.tos_url && !tosAgreed)}
                className="w-full btn-primary disabled:opacity-50"
              >
                {isSubmitting ? 'Submitting...' : 'Submit Request'}
              </button>
            </form>
          </div>
        )

      case STEPS.NO_TEAMS:
        return (
          <div className="card">
            <div className="text-center mb-6">
              <img
                className="mx-auto h-32 w-auto mb-4"
                src="/assets/tak-nz-logo.svg"
                alt="TAK.NZ"
              />
              <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                {teams.length > 0 ? "Can't Find Your Team?" : 'No Teams Available'}
              </h2>
              <p className="text-gray-600 dark:text-gray-400 mt-2">
                {teams.length > 0
                  ? "If your team or organisation isn't listed, let us know below and we'll be in touch."
                  : 'There are no teams available for your email domain. If you represent an organisation, let us know below.'}
              </p>
            </div>

            <form onSubmit={handleOrgInterestSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    First Name
                  </label>
                  <input
                    type="text"
                    className="input w-full"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    required
                    placeholder="Joe"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Last Name
                  </label>
                  <input
                    type="text"
                    className="input w-full"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    required
                    placeholder="Bloggs"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Organisation Name
                </label>
                <input
                  type="text"
                  className="input w-full"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  required
                  placeholder="Your organisation name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  className="input w-full bg-gray-100 dark:bg-gray-600"
                  value={verifiedEmail}
                  readOnly
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting || !firstName || !lastName || !orgName}
                className="w-full btn-primary disabled:opacity-50"
              >
                {isSubmitting ? 'Submitting...' : 'Submit Interest'}
              </button>
            </form>

            {teams.length > 0 && (
              <div className="text-center mt-4">
                <button
                  type="button"
                  onClick={() => setStep(STEPS.TEAM_SELECTION)}
                  className="text-sm text-primary-600 hover:text-primary-500 underline"
                >
                  Back to team selection
                </button>
              </div>
            )}
          </div>
        )

      case STEPS.SUBMIT_SUCCESS:
        return (
          <div className="card text-center">
            <div className="w-16 h-16 mx-auto mb-4 bg-green-100 dark:bg-green-900 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">Request Submitted</h2>
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              Your request has been submitted. We'll review it shortly.
            </p>
            {config.authentik_origin ? (
              <a href={config.authentik_origin} className="btn-primary inline-block">
                Back to Login
              </a>
            ) : (
              <Link to="/" className="btn-primary inline-block">
                Back to Login
              </Link>
            )}
          </div>
        )

      case STEPS.ORG_INTEREST_SUBMITTED:
        return (
          <div className="card text-center">
            <div className="w-16 h-16 mx-auto mb-4 bg-green-100 dark:bg-green-900 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">Thank You</h2>
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              Thank you. We'll be in touch about your organisation.
            </p>
            {config.authentik_origin ? (
              <a href={config.authentik_origin} className="btn-primary inline-block">
                Back to Login
              </a>
            ) : (
              <Link to="/" className="btn-primary inline-block">
                Back to Login
              </Link>
            )}
          </div>
        )

      case STEPS.EXPIRED:
        return (
          <div className="card text-center">
            <div className="w-16 h-16 mx-auto mb-4 bg-red-100 dark:bg-red-900 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">Link Expired</h2>
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              This link has expired. Please start the sign-up process again.
            </p>
            <Link to="/request-access" className="btn-primary inline-block">
              Start Over
            </Link>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <ThemeProvider>
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4">
        <div className="max-w-md w-full">
          {renderStep()}
        </div>
      </div>
    </ThemeProvider>
  )
}
