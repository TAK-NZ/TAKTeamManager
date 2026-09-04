import { useState, useEffect, useCallback } from 'react'
import { ClipboardDocumentIcon, ArrowPathIcon, TrashIcon, QrCodeIcon, DocumentIcon } from '@heroicons/react/24/outline'
import { signupCodesAPI } from '../services/api'
import toast from 'react-hot-toast'

/**
 * SignupCodeManager — panel for TeamDetail page showing the team's current
 * sign-up code and management actions. Only rendered for team admins.
 *
 * @param {{ teamId: number, teamName: string, isAdmin: boolean }} props
 */
export default function SignupCodeManager({ teamId, teamName, isAdmin }) {
  const [code, setCode] = useState(null) // { code, formatted_code, created_at } or null
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false) // generate confirmation
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false)

  // Wrapped in useCallback (stable per teamId) so the effect can depend on
  // it without re-running every render -- satisfies exhaustive-deps with no
  // behaviour change (still one fetch per teamId/isAdmin change).
  const fetchCode = useCallback(async () => {
    setLoading(true)
    try {
      const res = await signupCodesAPI.get(teamId)
      setCode(res.data)
    } catch (err) {
      if (err.response?.status === 404) {
        setCode(null)
      } else {
        console.error('Failed to fetch signup code:', err)
      }
    } finally {
      setLoading(false)
    }
  }, [teamId])

  useEffect(() => {
    if (!teamId || !isAdmin) return
    fetchCode()
  }, [teamId, isAdmin, fetchCode])

  const handleGenerate = async () => {
    setShowConfirm(false)
    setGenerating(true)
    try {
      const res = await signupCodesAPI.generate(teamId)
      setCode(res.data)
      toast.success('Sign-up code generated')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to generate code')
    } finally {
      setGenerating(false)
    }
  }

  const handleRevoke = async () => {
    setRevoking(true)
    try {
      await signupCodesAPI.revoke(teamId)
      setCode(null)
      setShowRevokeConfirm(false)
      toast.success('Sign-up code revoked')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to revoke code')
    } finally {
      setRevoking(false)
    }
  }

  const handleCopyUrl = () => {
    // Use the URL from the server response, or construct one from the raw code
    const copyUrl = code?.url || `${window.location.origin}/request-access?code=${(code?.code || '').replace(/-/g, '')}`
    if (!copyUrl) return
    // navigator.clipboard requires HTTPS; fall back to execCommand for HTTP
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(copyUrl)
        .then(() => toast.success('URL copied to clipboard'))
        .catch(() => toast.error('Failed to copy URL'))
    } else {
      const textArea = document.createElement('textarea')
      textArea.value = copyUrl
      textArea.style.position = 'fixed'
      textArea.style.opacity = '0'
      document.body.appendChild(textArea)
      textArea.select()
      try {
        document.execCommand('copy')
        toast.success('URL copied to clipboard')
      } catch {
        toast.error('Failed to copy URL')
      }
      document.body.removeChild(textArea)
    }
  }

  const handleDownloadQr = async () => {
    try {
      const res = await signupCodesAPI.getQr(teamId)
      const blob = new Blob([res.data], { type: 'image/png' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${teamName || 'team'}-signup-qr.png`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      toast.error('Failed to download QR code')
    }
  }

  const handleDownloadPdf = async () => {
    try {
      const res = await signupCodesAPI.getPdf(teamId)
      const blob = new Blob([res.data], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${teamName || 'team'}-signup-code.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      toast.error('Failed to download PDF')
    }
  }

  if (!isAdmin) return null

  if (loading) {
    return (
      <div className="card">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Sign-up Code</h3>
        <div className="animate-pulse h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/2"></div>
      </div>
    )
  }

  return (
    <div className="card">
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
        Sign-up Code:{' '}
        {code
          ? <span className="font-mono tracking-wider">{code.formatted || code.code}</span>
          : <span className="text-gray-500 dark:text-gray-400 font-normal">No sign-up code generated</span>
        }
      </h3>

      {code ? (
        <>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleCopyUrl}
              className="btn-secondary text-sm flex items-center gap-1"
            >
              <ClipboardDocumentIcon className="h-4 w-4" />
              Copy URL
            </button>
            <button
              onClick={handleDownloadQr}
              className="btn-secondary text-sm flex items-center gap-1"
            >
              <QrCodeIcon className="h-4 w-4" />
              Download QR
            </button>
            <button
              onClick={handleDownloadPdf}
              className="btn-secondary text-sm flex items-center gap-1"
            >
              <DocumentIcon className="h-4 w-4" />
              Download PDF
            </button>
            <button
              onClick={() => setShowConfirm(true)}
              disabled={generating}
              className="btn-secondary text-sm flex items-center gap-1"
            >
              <ArrowPathIcon className="h-4 w-4" />
              {generating ? 'Generating...' : 'Regenerate'}
            </button>
            <button
              onClick={() => setShowRevokeConfirm(true)}
              disabled={revoking}
              className="btn-secondary text-sm text-red-600 dark:text-red-400 flex items-center gap-1"
            >
              <TrashIcon className="h-4 w-4" />
              {revoking ? 'Revoking...' : 'Revoke'}
            </button>
          </div>
        </>
      ) : (
        <>
          <button
            onClick={() => setShowConfirm(true)}
            disabled={generating}
            className="btn-primary text-sm"
          >
            {generating ? 'Generating...' : 'Generate Code'}
          </button>
        </>
      )}

      {/* Generate confirmation dialog */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="generate-signup-code-title"
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-sm w-full p-6"
          >
            <h3 id="generate-signup-code-title" className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
              {code ? 'Regenerate Code?' : 'Generate Sign-up Code?'}
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Generating a code will hide this team from the general sign-up list.
              Only users with the code will be able to request access to this team.
              {code && ' The existing code will be replaced and all previous links will stop working.'}
            </p>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setShowConfirm(false)}
                className="btn-secondary px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleGenerate}
                disabled={generating}
                className="btn-primary px-4 py-2 text-sm"
              >
                {generating ? 'Generating...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Revoke confirmation dialog */}
      {showRevokeConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="revoke-signup-code-title"
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-sm w-full p-6"
          >
            <h3 id="revoke-signup-code-title" className="text-lg font-medium text-red-600 dark:text-red-400 mb-2">
              Revoke Sign-up Code?
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Are you sure you want to revoke this code? All distributed links and QR codes will stop working immediately.
            </p>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setShowRevokeConfirm(false)}
                className="btn-secondary px-4 py-2 text-sm"
                disabled={revoking}
              >
                Cancel
              </button>
              <button
                onClick={handleRevoke}
                disabled={revoking}
                className="btn-danger text-sm disabled:opacity-50"
              >
                {revoking ? 'Revoking...' : 'Revoke Code'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
