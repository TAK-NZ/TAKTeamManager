import { useState, useEffect, useRef, useCallback } from 'react'
import { UserGroupIcon, UsersIcon, CogIcon, CheckIcon, ArrowUpTrayIcon, ArrowDownTrayIcon, DocumentTextIcon, EnvelopeIcon, NoSymbolIcon, ArrowsRightLeftIcon, DevicePhoneMobileIcon, SignalIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { configAPI, usersAPI, teamsAPI, syncAPI, bulkImportAPI, communicationsAPI, settingsAPI, adminAPI } from '../services/api'
import FormattedDate, { DATE_PRECISION, TOOLTIP_SIDES } from '../components/FormattedDate'
import { getVariableHints } from '../utils/templateVariableHints'
import { buildTemplateUpdatePayload, validateTemplateDraft } from '../utils/templateUpdatePayload'
import { unzipExportedArchive, isImportPayloadShape } from '../utils/settingsImportTransform'
import ExcludedDomainsManager from '../components/ExcludedDomainsManager'
import { formatQueueAge } from '../utils/formatQueueAge'
import { formatNumber } from '../utils/formatNumber'
// Keep the stat cards + sync-status current while the page is open, on the
// same visibility-paused 60s interval the Dashboard cards use (shared util).
// Only the read-only display data auto-refreshes; the editor/form surfaces
// (site config, email templates, bulk import, export/import) deliberately do
// NOT, so a background refresh can never disturb operator-in-progress input.
import { startVisibilityPausedRefresh } from '../utils/visibilityPausedRefresh'

export default function Admin({ user }) {
  const [stats, setStats] = useState({ totalUsers: 0, totalTeams: 0, totalDevices: 0, totalChannels: 0 })
  const [syncStatus, setSyncStatus] = useState(null)
  const [syncing, setSyncing] = useState(false)
  // Tracks whether the component is still mounted, so the User Sync polling
  // loop below never calls setState after unmount (it can run for up to ~2min).
  const isMountedRef = useRef(true)
  // Background-process health for the "Background Sync" card (queue backlog
  // depth + oldest-pending age, the user_sync row, worker heartbeat liveness).
  // Auto-refreshed alongside the stat cards; never cleared on a failed refresh.
  const [syncHealth, setSyncHealth] = useState(null)
  // --- Site Content editor state (dropdown-selector pattern, matching the
  // Email Templates tab below). `siteConfig` remains the single fetched list
  // (Requirement source of truth); `selectedConfigKey` is the one item
  // currently open for editing, replacing the old per-row `editingConfig`
  // inline-edit approach. `configDraftValue` is the controlled-input draft;
  // `configOriginalValue` is the last-loaded value, used for no-op detection
  // on save exactly like `templateOriginal` does for Email Templates.
  const [siteConfig, setSiteConfig] = useState([])
  const [selectedConfigKey, setSelectedConfigKey] = useState('')
  const [configDraftValue, setConfigDraftValue] = useState('')
  const [configOriginalValue, setConfigOriginalValue] = useState('')
  const [configSaving, setConfigSaving] = useState(false)
  const [configSaveError, setConfigSaveError] = useState(null)
  const [configSaveSuccess, setConfigSaveSuccess] = useState(null)
  const [configNoChanges, setConfigNoChanges] = useState(false)

  // --- Email Template Editor state (admin-settings-management, task 7.1) ---
  // The template list is the single source of truth for the set of editable
  // Template_Keys (Requirement 2.1); it comes from `communicationsAPI` over the
  // shared, correctly-configured `api` axios instance (never raw axios / no
  // localStorage token -- see the note in the effect below and the wrappers in
  // services/api.js). Load errors are surfaced, not swallowed (Req 2.6/3.4/3.5).
  const [templateList, setTemplateList] = useState([])
  const [templateListError, setTemplateListError] = useState(null)
  const [selectedTemplateKey, setSelectedTemplateKey] = useState('')
  // `templateSubject`/`templateBody` are held as controlled-input state so the
  // later save task (7.2) can wire draft editing/validation directly onto them.
  const [templateSubject, setTemplateSubject] = useState('')
  const [templateBody, setTemplateBody] = useState('')
  const [templateDescription, setTemplateDescription] = useState('')
  const [templateUpdatedAt, setTemplateUpdatedAt] = useState(null)
  // Load-time status/error for a single selected template (distinct from the
  // list-fetch error above): not-found (404) vs other load errors (Req 3.4/3.5).
  const [templateLoadError, setTemplateLoadError] = useState(null)
  const [templateLoaded, setTemplateLoaded] = useState(false)
  // --- Email Template save state (admin-settings-management, task 7.2) ---
  // The loaded template's original `{ subject, body }` is remembered so the
  // save path can send only the fields the operator actually changed
  // (buildTemplateUpdatePayload) and can do nothing when nothing changed --
  // avoiding the server's "at least one required" 400. `templateSubject`/
  // `templateBody` remain the live draft.
  const [templateOriginal, setTemplateOriginal] = useState({ subject: '', body: '' })
  const [templateSaving, setTemplateSaving] = useState(false)
  // `templateSaveError` holds either a validation problems array (blocked before
  // any request, Req 4.3-4.5) or a single message string (a failed save request,
  // Req 4.7). `templateSaveSuccess`/`templateNoChanges` are advisory notices.
  const [templateSaveError, setTemplateSaveError] = useState(null)
  const [templateSaveSuccess, setTemplateSaveSuccess] = useState(null)
  const [templateNoChanges, setTemplateNoChanges] = useState(false)
  // --- Test email state (admin-settings-management, task 7.3, Req 6.1-6.5) ---
  // The target address is validated client-side (Req 6.3) before any request;
  // on send we include the currently-selected Template_Key when one is loaded
  // (Req 6.2). `testEmailStatus` is a success confirmation naming the address
  // (Req 6.4); `testEmailError` is either a client-side validation message or a
  // failed-send message (Req 6.5). `testEmailSending` guards the button.
  const [testEmailAddress, setTestEmailAddress] = useState('')
  const [testEmailStatus, setTestEmailStatus] = useState(null)
  const [testEmailError, setTestEmailError] = useState(null)
  const [testEmailSending, setTestEmailSending] = useState(false)
  
  // `fetchStats`/`fetchSyncStatus` are the ONLY two fetches on this page
  // that auto-refresh (the read-only stat cards + sync status). They are
  // hoisted to component scope as stable `useCallback`s so BOTH the
  // first-load effect and the visibility-paused refresh effect below call the
  // same function. Following the client-conventions refresh rules, neither
  // raises a spinner (there is none for these cards) and neither CLEARS the
  // last-good values on failure -- a failed background refresh just logs and
  // leaves the previously-rendered numbers on screen.
  //
  // Every raw axios.* call in this file previously sent
  // `Authorization: Bearer ${localStorage.getItem('token')}` -- but this app
  // has never stored a token in localStorage (auth lives solely in the
  // httpOnly `tak_session` cookie; see server/middleware/auth.js), so that
  // header was always literally "Bearer null" and the session cookie was
  // never sent, 401ing every call -- which is why the stats never loaded.
  // Replaced throughout with the shared, correctly-configured `api` instance.
  const fetchStats = useCallback(async () => {
    try {
      const [usersCountResponse, teamsResponse, adminStatsResponse] = await Promise.all([
        // Bugfix: "Total Users" previously read GET /api/users' own
        // pagination.total, which is Authentik's raw type=internal count
        // -- it included AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES matches
        // (e.g. etl- accounts) and still-internal-typed Team_Owned_Devices,
        // both of which that endpoint's own list filters out but its total
        // deliberately does not (see its doc comment). GET /api/users/count
        // is a dedicated, exact, unpaginated count excluding both.
        usersAPI.getCount(),
        teamsAPI.getMyTeams(),
        // Total Team Devices + Total Channels (team + global) -- a
        // dedicated Global-Manager-only aggregate endpoint.
        adminAPI.getStats()
      ])

      // teams.getMyTeams is paginated (default pageSize 50 -- see
      // server/middleware/pagination.js) -- use pagination.total, not
      // the returned array's .length, so this stat doesn't silently
      // undercount once there are more than one page of teams.
      setStats({
        totalUsers: usersCountResponse.data.count ?? 0,
        totalTeams: teamsResponse.data.pagination?.total ?? teamsResponse.data.teams?.length ?? 0,
        totalDevices: adminStatsResponse.data.totalDevices ?? 0,
        totalChannels: adminStatsResponse.data.totalChannels ?? 0
      })
    } catch (error) {
      // Failed background/first refresh: leave the last-good counts on
      // screen (never zero them), per the client-conventions refresh rule.
      console.error('Failed to fetch stats:', error)
    }
  }, [])

  const fetchSyncStatus = useCallback(async () => {
    try {
      const response = await syncAPI.getStatus()
      setSyncStatus(response.data)
    } catch (error) {
      console.error('Failed to fetch sync status:', error)
    }
  }, [])

  // Background-process health (queue backlog + worker heartbeat). Same refresh
  // discipline as fetchStats/fetchSyncStatus: no spinner, and never clear the
  // last-good value on a failed background refresh.
  const fetchSyncHealth = useCallback(async () => {
    try {
      const response = await adminAPI.getSyncStatus()
      setSyncHealth(response.data)
    } catch (error) {
      console.error('Failed to fetch background sync health:', error)
    }
  }, [])

  useEffect(() => {
    const fetchSiteConfig = async () => {
      try {
        const response = await configAPI.getAll()
        setSiteConfig(response.data.config)
      } catch (error) {
        console.error('Failed to fetch site config:', error)
      }
    }

    // Load the editable email templates from the single-source-of-truth list
    // endpoint (Req 2.4/2.5). On any failure, surface an error AND clear the
    // list so no stale/partial data is rendered (Req 2.6).
    const fetchTemplateList = async () => {
      // Req 1.4: never issue a communications template request for a
      // non-Global_Manager. React hooks cannot be conditional, so this effect
      // runs before the `if (!user?.isAdmin) return <AccessDenied/>` early
      // return executes on first render. Without this guard the template-list
      // call (a communications template endpoint) would fire for a non-admin.
      // The other fetches above are pre-existing behavior outside this spec.
      if (!user?.isAdmin) {
        return
      }
      try {
        const response = await communicationsAPI.listTemplates()
        setTemplateList(response.data.templates ?? [])
        setTemplateListError(null)
      } catch (error) {
        console.error('Failed to fetch email templates:', error)
        setTemplateList([])
        setTemplateListError('Failed to load email templates. Please try again.')
      }
    }

    fetchStats()
    fetchSyncStatus()
    fetchSyncHealth()
    fetchSiteConfig()
    fetchTemplateList()
    // `user?.isAdmin` is a dependency: fetchTemplateList guards on it
    // internally (it must not fetch templates for a non-admin), so the
    // effect must re-run if the caller's admin status changes.
    // `fetchStats`/`fetchSyncStatus` are stable (`useCallback` with no deps)
    // and are listed for exhaustive-deps correctness; `fetchSiteConfig`/
    // `fetchTemplateList` remain inline (load-once) so they are not deps.
  }, [user?.isAdmin, fetchStats, fetchSyncStatus, fetchSyncHealth])

  // Keep the read-only stat cards + sync status current while the page is
  // open, on the shared visibility-paused 60s interval (the same mechanism
  // the Dashboard cards use). Separate from the first-load effect above so
  // mounting still performs exactly one fetch per source --
  // `startVisibilityPausedRefresh` only SCHEDULES subsequent refreshes, it
  // does not fetch up front. Deliberately refreshes ONLY these two display
  // sources: the editor/form surfaces (site config, email templates, bulk
  // import, export/import) must never be refreshed out from under an
  // operator mid-edit.
  useEffect(() => {
    const refresh = () => {
      fetchStats()
      fetchSyncStatus()
      fetchSyncHealth()
    }
    return startVisibilityPausedRefresh(refresh)
  }, [fetchStats, fetchSyncStatus, fetchSyncHealth])

  // Keep the mounted flag honest for the async User Sync polling loop.
  useEffect(() => {
    isMountedRef.current = true
    return () => { isMountedRef.current = false }
  }, [])

  const [activeTab, setActiveTab] = useState('site')

  // --- Bulk Import (Team CSV) state (Requirements 9.14, 14.1) ---
  const [bulkImportFile, setBulkImportFile] = useState(null)
  const [bulkImporting, setBulkImporting] = useState(false)
  const [bulkImportResult, setBulkImportResult] = useState(null)
  const [bulkImportError, setBulkImportError] = useState(null)
  const bulkImportFileInputRef = useRef(null)
  // Bugfix (no feedback during a large CSV import -- the operator had
  // no way to tell the browser was still uploading vs. the server was
  // still processing rows, especially once the file grows past a
  // handful of rows: a real 82-row team hierarchy took ~30 seconds
  // server-side with the button just reading "Uploading..." the whole
  // time). Two distinct phases, tracked separately since they have
  // genuinely different progress signals available:
  //   - `bulkImportUploadPercent`: the BROWSER's upload of the file's
  //     bytes to the server, via axios's own `onUploadProgress` (a real
  //     byte-count percentage -- see `bulkImportAPI.importTeams`'s own
  //     doc comment). Reaches 100 almost immediately for a CSV this
  //     size; the network transfer itself was never the slow part.
  //   - `bulkImportProcessing`: true for the (much longer) phase AFTER
  //     the upload completes, while the server parses the CSV and
  //     creates every row via Team.create -- Requirement 29.6's
  //     per-row synchronous processing, which has no equivalent
  //     progress signal today (a single request/response, not a
  //     stream) -- so this can only be an INDETERMINATE "still
  //     working" indicator, not a determinate percentage.
  const [bulkImportUploadPercent, setBulkImportUploadPercent] = useState(0)
  const [bulkImportProcessing, setBulkImportProcessing] = useState(false)

  // --- Settings Export / Import state (admin-settings-management, tasks 8.1/8.2) ---
  // Both controls live in a dedicated "Export / Import" tab. Every call goes
  // through the shared `api` instance via `settingsAPI` (no raw axios / no
  // localStorage token). This is a SETTINGS export, not a domain-data backup,
  // and secrets (the TAK Server passphrase) are excluded by the server -- both
  // facts are surfaced as notices below (Req 7.5, 9.5, 10.1, 10.2).
  const [exportError, setExportError] = useState(null)
  const [exporting, setExporting] = useState(false)
  // Import file + branched-transform results. `importResult` holds the success
  // `imported` counts (Req 9.1); `importProblems` holds the 400 rejection list
  // (Req 9.2/9.3); `importError` is a client-side or generic transport message
  // (Req 8.6, 9.4). `importing` guards the button.
  const [importFile, setImportFile] = useState(null)
  const [importResult, setImportResult] = useState(null)
  const [importProblems, setImportProblems] = useState([])
  const [importError, setImportError] = useState(null)
  const [importing, setImporting] = useState(false)
  const settingsImportFileInputRef = useRef(null)

  // Load a single Site Content item's current value into the display fields
  // when an admin selects it from the dropdown, mirroring
  // `handleSelectTemplate` below. `siteConfig` was already fetched in full by
  // `fetchSiteConfig`, so "loading" here is a local lookup rather than a
  // network request.
  const handleSelectConfig = (configKey) => {
    setSelectedConfigKey(configKey)
    // Switching (or clearing) items always clears any stale save feedback
    // from the previously-selected item.
    setConfigSaveError(null)
    setConfigSaveSuccess(null)
    setConfigNoChanges(false)
    if (!configKey) {
      // Cleared selection -- reset the draft, nothing to load.
      setConfigDraftValue('')
      setConfigOriginalValue('')
      return
    }
    const config = siteConfig.find(c => c.config_key === configKey)
    const loadedValue = config?.config_value || ''
    setConfigDraftValue(loadedValue)
    setConfigOriginalValue(loadedValue)
  }

  const handleSaveConfig = async () => {
    if (!selectedConfigKey) {
      return
    }
    setConfigSaveSuccess(null)
    setConfigNoChanges(false)

    // No-op edit: skip the request entirely, same as the Email Template save
    // path (buildTemplateUpdatePayload's empty-payload branch).
    if (configDraftValue === configOriginalValue) {
      setConfigSaveError(null)
      setConfigNoChanges(true)
      return
    }

    setConfigSaving(true)
    setConfigSaveError(null)
    try {
      const response = await configAPI.update(selectedConfigKey, { value: configDraftValue })
      const savedValue = response.data.config?.config_value ?? configDraftValue
      setSiteConfig(prev => prev.map(c =>
        c.config_key === selectedConfigKey
          ? { ...c, config_value: savedValue }
          : c
      ))
      setConfigDraftValue(savedValue)
      setConfigOriginalValue(savedValue)
      setConfigSaveSuccess('Content saved.')
    } catch (error) {
      console.error('Failed to update config:', error)
      // Retain the operator's unsaved edits on failure, matching
      // handleSaveTemplate's behavior below.
      setConfigSaveError('Failed to save. Your changes were not saved and are still shown below.')
    } finally {
      setConfigSaving(false)
    }
  }

  // Load a single template's current content into the display fields when a
  // Global_Manager selects it (Req 3.1-3.5). All calls go through the shared
  // `api` instance via `communicationsAPI` (Req: no raw axios / no localStorage
  // token). Note: task 7.2 owns edit/save; this handler only loads.
  const handleSelectTemplate = async (key) => {
    setSelectedTemplateKey(key)
    // Switching (or clearing) templates always clears any stale save feedback
    // from the previously-loaded template (task 7.2).
    setTemplateSaveError(null)
    setTemplateSaveSuccess(null)
    setTemplateNoChanges(false)
    if (!key) {
      // Cleared selection -- reset display state, no request.
      setTemplateLoaded(false)
      setTemplateLoadError(null)
      setTemplateSubject('')
      setTemplateBody('')
      setTemplateDescription('')
      setTemplateUpdatedAt(null)
      setTemplateOriginal({ subject: '', body: '' })
      return
    }
    try {
      const response = await communicationsAPI.getTemplate(key)
      const template = response.data.template
      const loadedSubject = template.subject_template ?? ''
      const loadedBody = template.body_template ?? ''
      setTemplateSubject(loadedSubject)
      setTemplateBody(loadedBody)
      setTemplateDescription(template.description ?? '')
      setTemplateUpdatedAt(template.updated_at ?? null)
      // Remember the loaded values as the original so change-detection on save
      // compares against what was actually loaded (task 7.2).
      setTemplateOriginal({ subject: loadedSubject, body: loadedBody })
      setTemplateLoaded(true)
      setTemplateLoadError(null)
    } catch (error) {
      console.error('Failed to load email template:', error)
      // 404 -> not-found message; DO NOT populate fields from another template
      // (Req 3.4). Other load errors -> generic error; leave fields unchanged
      // (Req 3.5).
      if (error.response?.status === 404) {
        setTemplateLoadError(`Template "${key}" was not found.`)
      } else {
        setTemplateLoadError('Failed to load the selected template. Please try again.')
      }
    }
  }

  // Save the edited template (task 7.2, Req 4.2-4.7). Fails fast on validation
  // (Req 4.3-4.5) and on a no-op edit before touching the network; on success
  // updates the displayed fields and the remembered original from the returned
  // template (Req 4.6); on failure retains the operator's unsaved edits (Req 4.7).
  const handleSaveTemplate = async () => {
    if (!selectedTemplateKey) {
      return
    }
    setTemplateSaveSuccess(null)
    setTemplateNoChanges(false)

    const draft = { subject: templateSubject, body: templateBody }

    // Req 4.3/4.4/4.5: block the save and show the validation problems inline;
    // do NOT call the API.
    const problems = validateTemplateDraft(draft)
    if (problems.length > 0) {
      setTemplateSaveError(problems)
      return
    }

    // Only send the fields that changed. An empty payload means nothing changed,
    // so skip the request entirely (the server requires at least one field and
    // would otherwise 400).
    const payload = buildTemplateUpdatePayload(templateOriginal, draft)
    if (Object.keys(payload).length === 0) {
      setTemplateSaveError(null)
      setTemplateNoChanges(true)
      return
    }

    setTemplateSaving(true)
    setTemplateSaveError(null)
    try {
      const response = await communicationsAPI.updateTemplate(selectedTemplateKey, payload)
      const template = response.data.template
      const savedSubject = template.subject_template ?? ''
      const savedBody = template.body_template ?? ''
      // Req 4.6: reflect the server's returned template in the display fields
      // and updated_at, and treat the saved values as the new original.
      setTemplateSubject(savedSubject)
      setTemplateBody(savedBody)
      setTemplateUpdatedAt(template.updated_at ?? null)
      setTemplateOriginal({ subject: savedSubject, body: savedBody })
      setTemplateSaveSuccess('Template saved. It takes effect immediately for emails sent from now on.')
    } catch (error) {
      console.error('Failed to save email template:', error)
      // Req 4.7: surface an error and RETAIN the operator's unsaved edits (the
      // subject/body inputs are left exactly as they typed them).
      setTemplateSaveError('Failed to save the template. Your changes were not saved and are still shown below.')
    } finally {
      setTemplateSaving(false)
    }
  }

  // Send a test copy of the (optionally selected) template to a self-supplied
  // address (task 7.3, Req 6.1-6.5). Validates the address client-side and does
  // NOT call the API when it is empty/invalid (Req 6.3); otherwise sends via the
  // shared `api` instance, including the selected Template_Key when one is
  // loaded (Req 6.2). Success names the target address (Req 6.4); any failure
  // shows an error (Req 6.5).
  const handleSendTestEmail = async () => {
    setTestEmailStatus(null)
    setTestEmailError(null)

    const targetEmail = testEmailAddress.trim()
    // Req 6.3: block empty or syntactically invalid addresses before any request.
    if (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
      setTestEmailError('Enter a valid email address to send a test email.')
      return
    }

    setTestEmailSending(true)
    try {
      // Req 6.2: include the currently-selected Template_Key when a template is
      // selected; otherwise omit it so the server uses its default template.
      await communicationsAPI.sendTestEmail({
        targetEmail,
        templateKey: selectedTemplateKey || undefined,
      })
      // Req 6.4: success confirmation naming the target address.
      setTestEmailStatus(`Test email sent to ${targetEmail}.`)
    } catch (error) {
      console.error('Failed to send test email:', error)
      // Req 6.5: network error or non-2xx response -> error message.
      setTestEmailError('Failed to send the test email. Please try again.')
    } finally {
      setTestEmailSending(false)
    }
  }

  const triggerManualSync = async () => {
    setSyncing(true)
    let triggerResponse
    try {
      triggerResponse = await syncAPI.triggerUserSync()
    } catch (error) {
      console.error('Failed to trigger sync:', error)
      toast.error('Failed to start user sync')
      setSyncing(false)
      return
    }

    // The server reports whether a run actually started or one was already in
    // flight (the service no-ops a concurrent trigger). Surface that honestly
    // rather than showing a fresh-sync result for a click that did nothing.
    const alreadyRunning = triggerResponse?.data?.alreadyRunning === true
    if (alreadyRunning) {
      toast('A user sync is already running')
    } else {
      toast.success('User sync started')
    }

    // Poll the sync_status row until the run leaves the 'running' state (or a
    // safety timeout), so the card + toast reflect the ACTUAL outcome instead
    // of a fixed 2-second guess. `getStatus` returns the user_sync row
    // ({ status, last_sync, records_synced, error_message }).
    const POLL_INTERVAL_MS = 2000
    const MAX_ATTEMPTS = 60 // ~2 minutes ceiling; a longer run just stops being polled
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await sleep(POLL_INTERVAL_MS)
      if (!isMountedRef.current) return
      let statusResponse
      try {
        statusResponse = await syncAPI.getStatus()
      } catch {
        // A transient status-read failure shouldn't abort the whole poll;
        // try again on the next tick.
        continue
      }
      if (!isMountedRef.current) return
      const status = statusResponse.data
      setSyncStatus(status)

      if (status?.status && status.status !== 'running') {
        setSyncing(false)
        if (status.status === 'success') {
          // error_message is reused to carry a non-fatal skip note (e.g. the
          // reconciliation sweep was skipped for an incomplete fetch), so
          // surface it as a warning-ish toast rather than a plain success.
          if (status.error_message) {
            toast(`User sync finished: ${status.error_message}`)
          } else {
            const n = status.records_synced
            toast.success(
              typeof n === 'number' ? `User sync complete (${n} users)` : 'User sync complete'
            )
          }
        } else if (status.status === 'error') {
          toast.error(`User sync failed: ${status.error_message || 'unknown error'}`)
        }
        return
      }
    }

    // Timed out waiting: stop the spinner but don't claim success/failure —
    // the run may still be going; the auto-refresh will catch up.
    if (isMountedRef.current) {
      setSyncing(false)
      toast('User sync is taking a while; check back shortly')
    }
  }

  const handleBulkImportFileChange = (e) => {
    setBulkImportFile(e.target.files?.[0] || null)
    setBulkImportResult(null)
    setBulkImportError(null)
  }

  const handleBulkImportUpload = async () => {
    if (!bulkImportFile) {
      return
    }
    setBulkImporting(true)
    setBulkImportUploadPercent(0)
    setBulkImportProcessing(false)
    setBulkImportResult(null)
    setBulkImportError(null)
    try {
      const formData = new FormData()
      formData.append('csv', bulkImportFile)
      const response = await bulkImportAPI.importTeams(formData, (progressEvent) => {
        if (!progressEvent.total) {
          return
        }
        const percent = Math.round((progressEvent.loaded / progressEvent.total) * 100)
        setBulkImportUploadPercent(percent)
        // Once the browser has finished streaming the file's bytes, the
        // remaining wait is entirely server-side row processing, which
        // has no percentage of its own -- switch to the indeterminate
        // indicator rather than leaving the bar frozen at 100%.
        if (percent >= 100) {
          setBulkImportProcessing(true)
        }
      })
      setBulkImportResult(response.data)
      setBulkImportFile(null)
      if (bulkImportFileInputRef.current) {
        bulkImportFileInputRef.current.value = ''
      }
    } catch (error) {
      console.error('Failed to import team CSV:', error)
      setBulkImportError(
        error.response?.data?.error || 'Failed to import team CSV. Please try again.'
      )
    } finally {
      setBulkImporting(false)
      setBulkImportProcessing(false)
      setBulkImportUploadPercent(0)
    }
  }

  // --- Settings Export (task 8.1, Req 7.1-7.4) ---
  // Request the Exported_Archive as a blob and hand it to the browser as a
  // downloaded file. On any failure we show a generic export-failure message:
  // because the response is a blob, a JSON error body arrives as a blob too, so
  // we deliberately do NOT try to parse it (Req 7.4, see design "Blob export edge").
  const handleExportSettings = async () => {
    setExportError(null)
    setExporting(true)
    try {
      const response = await settingsAPI.exportSettings()
      // Deliver the blob as a download by clicking a temporary anchor, then
      // release the object URL.
      const url = URL.createObjectURL(response.data)
      const link = document.createElement('a')
      link.href = url
      link.download = 'settings-export.zip'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Failed to export settings:', error)
      setExportError('Failed to export settings. Please try again.')
    } finally {
      setExporting(false)
    }
  }

  // Selecting a new import file clears any stale result/problems/error so the
  // operator never sees feedback from a previous attempt (Req 8/9).
  const handleImportFileChange = (e) => {
    setImportFile(e.target.files?.[0] || null)
    setImportResult(null)
    setImportProblems([])
    setImportError(null)
  }

  // --- Settings Import (task 8.2, Req 8.1-8.6, 9.1-9.4) ---
  // Branch on the selected file: a raw `.json` file is parsed and shape-checked
  // in the browser; anything else is treated as a `.zip` Exported_Archive and
  // unzipped+merged via the Import_Transform. Either branch that cannot produce
  // a valid Import_Payload shows an error and does NOT call the API (Req 8.6).
  // Once a payload is obtained we submit it and distinguish three outcomes:
  // success counts (Req 9.1), an expected 400 rejection with a problems list and
  // a no-change statement (Req 9.2/9.3), and a generic transport error (Req 9.4).
  const handleImportSettings = async () => {
    if (!importFile) {
      return
    }
    setImportResult(null)
    setImportProblems([])
    setImportError(null)

    // Step 1: build the Import_Payload from the selected file (client-side only).
    let payload
    const isJsonFile = importFile.name.toLowerCase().endsWith('.json')
    if (isJsonFile) {
      // Raw merged `.json`: parse (guarded) then require the exact payload shape.
      let parsed
      try {
        const text = await importFile.text()
        parsed = JSON.parse(text)
      } catch (error) {
        console.error('Failed to parse import JSON:', error)
        setImportError('The selected file is not valid JSON. No settings were imported.')
        return
      }
      if (!isImportPayloadShape(parsed)) {
        setImportError(
          'The selected file is not a valid settings import (expected systemConfig and siteConfig arrays). No settings were imported.'
        )
        return
      }
      payload = parsed
    } else {
      // Treat as a `.zip` Exported_Archive: unzip + merge in the browser.
      try {
        const buf = await importFile.arrayBuffer()
        payload = await unzipExportedArchive(buf)
      } catch (error) {
        console.error('Failed to read import archive:', error)
        setImportError('The selected file could not be read as a settings archive. No settings were imported.')
        return
      }
    }

    // Step 2: submit the payload. The 400 rejection is an expected, first-class
    // outcome, not a generic error.
    setImporting(true)
    try {
      const response = await settingsAPI.importSettings(payload)
      setImportResult(response.data.imported)
    } catch (error) {
      const problems = error.response?.data?.problems
      if (error.response?.status === 400 && Array.isArray(problems)) {
        // Req 9.2/9.3: render each problem and state that nothing changed.
        setImportProblems(problems)
      } else {
        // Req 9.4: any other transport failure.
        console.error('Failed to import settings:', error)
        setImportError('Failed to import settings. Please try again.')
      }
    } finally {
      setImporting(false)
    }
  }

  if (!user?.isAdmin) {
    return (
      <div className="text-center py-12">
        <CogIcon className="mx-auto h-12 w-12 text-gray-400" />
        <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">Access Denied</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          You need global admin privileges to access this page.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Global Administration
        </h1>
        <p className="text-gray-600 dark:text-gray-400">
          Manage the TAK Team Manager system.
        </p>
      </div>

      {/* Admin Stats: four count cards -- two per row on a tablet, all four
          on one row at `lg`, stacked on a phone. The User Sync card moved to
          its own full-width row below so adding these two counts didn't
          squeeze it. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <UserGroupIcon className="h-8 w-8 text-primary-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Teams</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{formatNumber(stats.totalTeams)}</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <UsersIcon className="h-8 w-8 text-green-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Users</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{formatNumber(stats.totalUsers)}</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <DevicePhoneMobileIcon className="h-8 w-8 text-amber-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Team Devices</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{formatNumber(stats.totalDevices)}</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <SignalIcon className="h-8 w-8 text-purple-600" />
            </div>
            <div className="ml-4">
              {/* Total Channels = team channels + global channels (BCH +
                  region), per the server's GET /api/admin/stats. */}
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Channels</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{formatNumber(stats.totalChannels)}</p>
            </div>
          </div>
        </div>
      </div>

      {/* User Sync card -- its own row (was the third cell of the old
          3-col stats grid, moved out when the two new count cards were
          added).
          Mobile fix: below `sm:`, the icon/label/status block and the Sync
          Now button stack instead of squeezing onto one row (a
          `text-xs px-3 py-1` button was also below this app's ~36px tap
          target floor -- bumped to `text-sm px-3 py-1.5`, matching the
          floor other small secondary buttons on this page already use,
          e.g. "Send test email"'s sizing). */}
      <div className="grid grid-cols-1">
        <div className="card">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <CogIcon className="h-8 w-8 text-blue-600" />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500 dark:text-gray-400">User Sync</p>
                {/* Clarify scope: this is the user/identity pull+push from
                    Authentik (new/edited accounts, attributes, orphan sweep),
                    NOT the channel/group-membership reconcile (that runs on its
                    own background sweep and via the Global Channels page). */}
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Pulls users from Authentik and pushes profile changes back. Not channel membership.
                </p>
                <div className="flex items-center space-x-2">
                  <p className={`text-sm font-bold ${
                    syncStatus?.status === 'success' ? 'text-green-600' :
                    syncStatus?.status === 'running' || syncing ? 'text-blue-600' :
                    syncStatus?.status === 'error' ? 'text-red-600' : 'text-gray-600'
                  }`}>
                    {syncing ? 'Syncing...' :
                     syncStatus?.status === 'success' ? 'Synced' :
                     syncStatus?.status === 'running' ? 'Running' :
                     syncStatus?.status === 'error' ? 'Error' : 'Unknown'}
                  </p>
                  {syncStatus?.last_sync && !syncing && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {/* Date_Render_Position 9: the last sync timestamp, rendered
                          through the one shared Formatted_Date so it carries the
                          same Date_Tooltip as every other date (Criteria 2.1, 2.2)
                          while the visible string stays what `formatDateTime`
                          renders today, character for character (Criterion 2.3).
                          This is a NON-TABLE position -- a `<p>` inside a card --
                          and it deliberately takes the same
                          Sideways_Tooltip_Placement as the table cells, so the
                          application has ONE tooltip behaviour rather than one per
                          surrounding element type (Criterion 3.8). `fallback=''` is
                          the Date_Format_Helpers' own default, which is what this
                          site renders today for an unparseable value. */}
                      <FormattedDate
                        value={syncStatus.last_sync}
                        fallback=""
                        precision={DATE_PRECISION.DATE_TIME}
                        side={TOOLTIP_SIDES.RIGHT}
                      />
                    </p>
                  )}
                </div>
              </div>
            </div>
            <button
              onClick={triggerManualSync}
              disabled={syncing || syncStatus?.status === 'running'}
              className="btn-secondary text-sm px-3 py-1.5 disabled:opacity-50 flex-shrink-0"
            >
              {syncing ? 'Syncing...' : 'Sync Now'}
            </button>
          </div>
        </div>
      </div>

      {/* Background Sync card: how far behind the background processes are.
          Previously an admin had no in-UI insight into the sync_operations
          backlog or whether the Sync_Worker was even alive -- both are now
          surfaced here (GET /api/admin/sync-status), auto-refreshed on the same
          visibility-paused interval as the stat cards. Every state is carried
          in TEXT (never colour alone); the icons are decorative
          (`aria-hidden`) and sit beside real words. */}
      {syncHealth && (
        <div className="grid grid-cols-1">
          <div className="card space-y-3">
            <div className="flex items-center">
              <CogIcon className="h-8 w-8 text-blue-600 flex-shrink-0" aria-hidden="true" />
              <p className="ml-4 text-sm font-medium text-gray-500 dark:text-gray-400">Background Sync</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {/* Queue backlog depth */}
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Queued operations</p>
                <p className="text-xl font-bold text-gray-900 dark:text-gray-100">
                  {formatNumber(syncHealth.queue?.pending ?? 0)}
                </p>
                {syncHealth.queue?.failedRecent > 0 && (
                  <p className="text-xs text-red-600 dark:text-red-400">
                    {formatNumber(syncHealth.queue.failedRecent)} failed (24h)
                  </p>
                )}
              </div>

              {/* How far behind, in wall-clock terms */}
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Oldest queued</p>
                <p className="text-xl font-bold text-gray-900 dark:text-gray-100">
                  {syncHealth.queue?.oldestPendingAgeSeconds != null
                    ? formatQueueAge(syncHealth.queue.oldestPendingAgeSeconds)
                    : '—'}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {syncHealth.queue?.pending ? 'behind' : 'queue empty'}
                </p>
              </div>

              {/* Sync-worker liveness -- carried in TEXT, colour only reinforces */}
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Sync worker</p>
                <p className={`text-xl font-bold ${
                  syncHealth.worker?.stale ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'
                }`}>
                  {syncHealth.worker?.stale ? 'Not responding' : 'Healthy'}
                </p>
                {syncHealth.worker?.lastHeartbeatAt && (
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    last beat{' '}
                    <FormattedDate
                      value={syncHealth.worker.lastHeartbeatAt}
                      fallback=""
                      precision={DATE_PRECISION.DATE_TIME}
                      side={TOOLTIP_SIDES.RIGHT}
                    />
                  </p>
                )}
              </div>
            </div>

            {/* Per-type breakdown of the pending backlog, when there is one. */}
            {syncHealth.queue?.pendingByType?.length > 0 && (
              <div className="text-xs text-gray-500 dark:text-gray-400">
                <span className="font-medium">Pending by type: </span>
                {syncHealth.queue.pendingByType
                  .map((t) => `${t.operation_type} (${t.count})`)
                  .join(', ')}
              </div>
            )}

            {/* The completeness-guard "sweep skipped: incomplete fetch" note (or
                any user_sync error) surfaces here rather than staying invisible
                in the DB. */}
            {syncHealth.userSync?.message && (
              <div className="text-xs text-amber-700 dark:text-amber-300">
                <span className="font-medium">Last sync note: </span>
                {syncHealth.userSync.message}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Configuration Tabs. Mobile fix: below `sm:`, each tab collapses to
          its icon alone (no visible label) so all five fit one row without
          horizontal scrolling, matching TeamDetail.jsx's own tab-bar
          convention (icon + `hidden sm:inline` label, full text restored at
          `sm:` and up). The accessible name (aria-label/title) always
          carries the full label regardless of which text is visible. */}
      <div className="card">
        <div className="border-b border-gray-200 dark:border-gray-700">
          <nav className="-mb-px flex space-x-3 sm:space-x-8" role="tablist">
            {[
              { id: 'site', label: 'Site Content', icon: DocumentTextIcon },
              { id: 'emailTemplates', label: 'Email Templates', icon: EnvelopeIcon },
              { id: 'bulkImport', label: 'Bulk Import', icon: ArrowUpTrayIcon },
              { id: 'excludedDomains', label: 'Excluded Domains', icon: NoSymbolIcon },
              { id: 'settingsBackup', label: 'Export / Import', icon: ArrowsRightLeftIcon }
            ].map((tab) => {
              const Icon = tab.icon
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  aria-label={tab.label}
                  title={tab.label}
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  className={`flex items-center py-2 px-1 border-b-2 font-medium text-sm flex-shrink-0 ${
                    activeTab === tab.id
                      ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
                  }`}
                >
                  <Icon className="h-5 w-5 sm:h-4 sm:w-4 sm:mr-2" aria-hidden="true" />
                  <span className="hidden sm:inline">{tab.label}</span>
                </button>
              )
            })}
          </nav>
        </div>

        <div className="mt-4">
          {activeTab === 'site' && (
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                View and edit text content displayed on the request access page. Select an item to
                load its current content.
              </p>

              <div className="mb-4">
                <label
                  htmlFor="site-content-select"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                >
                  Content item
                </label>
                <select
                  id="site-content-select"
                  value={selectedConfigKey}
                  onChange={(e) => handleSelectConfig(e.target.value)}
                  className="w-full sm:w-96 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                >
                  <option value="">Select an item...</option>
                  {siteConfig
                    .filter(config => config.config_key.startsWith('request_access'))
                    .map((config) => (
                      <option key={config.config_key} value={config.config_key}>
                        {config.description || config.config_key}
                      </option>
                    ))}
                </select>
              </div>

              {selectedConfigKey && (
                <div className="space-y-4">
                  <div>
                    <label
                      htmlFor="site-content-value"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      Content
                    </label>
                    <textarea
                      id="site-content-value"
                      value={configDraftValue}
                      onChange={(e) => {
                        setConfigDraftValue(e.target.value)
                        // Editing updates only draft state and issues no request;
                        // clear any stale save feedback, matching the Email
                        // Template editor's onChange handlers.
                        setConfigSaveError(null)
                        setConfigSaveSuccess(null)
                        setConfigNoChanges(false)
                      }}
                      rows={selectedConfigKey === 'request_access_footer' ? 4 : 2}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    />
                  </div>

                  {configSaveError && (
                    <div className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 p-3">
                      <p className="text-sm text-red-700 dark:text-red-300">{configSaveError}</p>
                    </div>
                  )}

                  {configNoChanges && (
                    <div className="rounded border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 p-3">
                      <p className="text-sm text-gray-700 dark:text-gray-300">
                        No changes to save.
                      </p>
                    </div>
                  )}

                  {configSaveSuccess && (
                    <div className="rounded border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/30 p-3">
                      <p className="text-sm text-green-700 dark:text-green-300">{configSaveSuccess}</p>
                    </div>
                  )}

                  <div>
                    <button
                      onClick={handleSaveConfig}
                      disabled={configSaving}
                      className="btn-primary flex items-center gap-2 disabled:opacity-50"
                    >
                      <CheckIcon className="h-4 w-4" />
                      {configSaving ? 'Saving...' : 'Save Content'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'emailTemplates' && (
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                View and edit the email templates the system sends. Select a template to load its
                current subject and body.
              </p>

              {/* List-fetch failure: show an error and render no (stale/partial)
                  selector options (Req 2.6). */}
              {templateListError && (
                <div className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 p-3 mb-4">
                  <p className="text-sm text-red-700 dark:text-red-300">{templateListError}</p>
                </div>
              )}

              {!templateListError && (
                <div className="mb-4">
                  <label
                    htmlFor="email-template-select"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                  >
                    Template
                  </label>
                  <select
                    id="email-template-select"
                    value={selectedTemplateKey}
                    onChange={(e) => handleSelectTemplate(e.target.value)}
                    className="w-full sm:w-96 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  >
                    <option value="">Select a template...</option>
                    {templateList.map((template) => (
                      <option key={template.template_key} value={template.template_key}>
                        {template.template_key}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Single-template load failure: 404 not-found or other error.
                  Fields are left unchanged / unpopulated (Req 3.4/3.5). */}
              {templateLoadError && (
                <div className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 p-3 mb-4">
                  <p className="text-sm text-red-700 dark:text-red-300">{templateLoadError}</p>
                </div>
              )}

              {/* Test email control (task 7.3, Req 6.1-6.5). Shown for the whole
                  Email Templates section so an operator can always send a test;
                  when a template is selected its Template_Key is included in the
                  request (Req 6.2), otherwise the server uses its default. */}
              <div className="mb-4 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-3">
                <label
                  htmlFor="test-email-address"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                >
                  Send test email
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                  {selectedTemplateKey
                    ? `Sends a copy of the "${selectedTemplateKey}" template to the address below.`
                    : 'Select a template above to send a copy of it, or send a default test email.'}
                </p>
                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                  <input
                    id="test-email-address"
                    type="email"
                    value={testEmailAddress}
                    onChange={(e) => {
                      setTestEmailAddress(e.target.value)
                      // Typing clears stale success/validation/error feedback.
                      setTestEmailStatus(null)
                      setTestEmailError(null)
                    }}
                    placeholder="you@example.com"
                    className="w-full sm:w-96 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  />
                  <button
                    onClick={handleSendTestEmail}
                    disabled={testEmailSending}
                    className="btn-primary flex items-center gap-2 disabled:opacity-50 whitespace-nowrap"
                  >
                    {testEmailSending ? 'Sending...' : 'Send test email'}
                  </button>
                </div>

                {/* Client-side validation message or a failed-send error
                    (Req 6.3/6.5). */}
                {testEmailError && (
                  <p className="mt-2 text-sm text-red-700 dark:text-red-300">{testEmailError}</p>
                )}

                {/* Success confirmation naming the target address (Req 6.4). */}
                {testEmailStatus && (
                  <p className="mt-2 text-sm text-green-700 dark:text-green-300">{testEmailStatus}</p>
                )}
              </div>

              {templateLoaded && !templateLoadError && (
                <div className="space-y-4">
                  {/* description / updated_at display (Req 3.3) */}
                  <div className="text-sm text-gray-600 dark:text-gray-400">
                    {templateDescription && <p>{templateDescription}</p>}
                    {templateUpdatedAt && (
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {/* Date_Render_Position 10: the template's last-updated
                            timestamp, on the same terms as the last-sync value
                            above. The literal `Last updated: ` label stays OUTSIDE
                            the component -- only the VALUE acquires the disclosure
                            -- so the rendered string is unchanged character for
                            character, the separating space included (Criterion
                            2.3). */}
                        Last updated:{' '}
                        <FormattedDate
                          value={templateUpdatedAt}
                          fallback=""
                          precision={DATE_PRECISION.DATE_TIME}
                          side={TOOLTIP_SIDES.RIGHT}
                        />
                      </p>
                    )}
                  </div>

                  {/* Advisory variable hints (Req 5.1-5.3). Labeled as advisory
                      and NOT enforced. Empty list => render nothing, never block. */}
                  {getVariableHints(selectedTemplateKey).length > 0 && (
                    <div className="rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-3">
                      <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                        Available variables (advisory only &mdash; not enforced; an unrecognised
                        placeholder is left as literal text when the email is sent):
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {getVariableHints(selectedTemplateKey).map((variable) => (
                          <code
                            key={variable}
                            className="px-1.5 py-0.5 text-xs rounded bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200"
                          >
                            {`{{${variable}}}`}
                          </code>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Subject / body are controlled inputs backed by state so the
                      save task (7.2) can wire draft editing/validation onto them.
                      Save/validation and the immediate-effect notice are owned by
                      task 7.2 and are intentionally not implemented here. */}
                  <div>
                    <label
                      htmlFor="email-template-subject"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      Subject
                    </label>
                    <input
                      id="email-template-subject"
                      type="text"
                      value={templateSubject}
                      onChange={(e) => {
                        setTemplateSubject(e.target.value)
                        // Editing updates only draft state and issues no request
                        // (Req 4.1); clear any stale save feedback (Req 4.6/4.7).
                        setTemplateSaveError(null)
                        setTemplateSaveSuccess(null)
                        setTemplateNoChanges(false)
                      }}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="email-template-body"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      Body
                    </label>
                    <textarea
                      id="email-template-body"
                      value={templateBody}
                      onChange={(e) => {
                        setTemplateBody(e.target.value)
                        // Editing updates only draft state and issues no request
                        // (Req 4.1); clear any stale save feedback (Req 4.6/4.7).
                        setTemplateSaveError(null)
                        setTemplateSaveSuccess(null)
                        setTemplateNoChanges(false)
                      }}
                      rows={10}
                      className="w-full px-2 py-1.5 text-sm font-mono border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    />
                  </div>

                  {/* Validation problems (array, blocked before any request,
                      Req 4.3-4.5) or a failed-save message (string, Req 4.7). */}
                  {templateSaveError && (
                    <div className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 p-3">
                      {Array.isArray(templateSaveError) ? (
                        <ul className="list-disc list-inside space-y-1">
                          {templateSaveError.map((problem, index) => (
                            <li key={index} className="text-sm text-red-700 dark:text-red-300">
                              {problem}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-sm text-red-700 dark:text-red-300">{templateSaveError}</p>
                      )}
                    </div>
                  )}

                  {/* No-op save: nothing changed, so no request was made. */}
                  {templateNoChanges && (
                    <div className="rounded border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 p-3">
                      <p className="text-sm text-gray-700 dark:text-gray-300">
                        No changes to save.
                      </p>
                    </div>
                  )}

                  {/* Success confirmation (Req 4.6). */}
                  {templateSaveSuccess && (
                    <div className="rounded border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/30 p-3">
                      <p className="text-sm text-green-700 dark:text-green-300">{templateSaveSuccess}</p>
                    </div>
                  )}

                  {/* Immediate-effect advisory notice (Req 4.8): the server's
                      EmailService reads template content from the database at
                      send time, so a saved template applies to the next email. */}
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    A saved template takes effect immediately: it is applied to every email sent
                    after you save, because the server reads template content from the database at
                    send time.
                  </p>

                  <div>
                    <button
                      onClick={handleSaveTemplate}
                      disabled={templateSaving}
                      className="btn-primary flex items-center gap-2 disabled:opacity-50"
                    >
                      <CheckIcon className="h-4 w-4" />
                      {templateSaving ? 'Saving...' : 'Save Template'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'bulkImport' && (
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                Import an entire Organisation's Team hierarchy from a CSV file. Download the template
                below for the expected columns, including how to reference a row's parent within the
                same file.
              </p>

              <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
                <input
                  ref={bulkImportFileInputRef}
                  type="file"
                  accept=".csv"
                  onChange={handleBulkImportFileChange}
                  className="text-sm text-gray-900 dark:text-gray-100 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-primary-50 file:text-primary-700 dark:file:bg-primary-900 dark:file:text-primary-300"
                />
                <button
                  onClick={handleBulkImportUpload}
                  disabled={!bulkImportFile || bulkImporting}
                  className="btn-primary flex items-center gap-2 disabled:opacity-50"
                >
                  {bulkImporting ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current"></div>
                  ) : (
                    <ArrowUpTrayIcon className="h-4 w-4" />
                  )}
                  {bulkImportProcessing
                    ? 'Processing...'
                    : bulkImporting
                      ? 'Uploading...'
                      : 'Upload Team CSV'}
                </button>
                <a
                  href="/templates/team-import-template.csv"
                  download
                  className="text-sm text-primary-600 hover:text-primary-900 dark:text-primary-400 dark:hover:text-primary-300 underline"
                >
                  Download CSV template
                </a>
              </div>

              {/* Bugfix (no feedback during a large CSV import): a
                  determinate progress bar for the upload phase (real
                  byte-count percentage), which SWITCHES to an
                  indeterminate "still working" bar the moment the
                  upload itself finishes and server-side row processing
                  begins -- the phase that actually took ~30 seconds for
                  an 82-row file, with nothing on screen before this fix.
                  `role="status"`/`aria-live="polite"` announces the
                  phase change once rather than on every byte-count tick,
                  matching this app's established convention (see
                  AddTeamDeviceDialog.jsx's "Checking callsign suffix…"
                  indicator) -- a region re-announcing a rapidly-changing
                  percentage would be unusable noise for a screen-reader
                  user. */}
              {bulkImporting && (
                <div className="mb-4">
                  <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400 mb-1">
                    <span>{bulkImportProcessing ? 'Creating teams…' : 'Uploading…'}</span>
                    {!bulkImportProcessing && <span>{bulkImportUploadPercent}%</span>}
                  </div>
                  <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                    {bulkImportProcessing ? (
                      <div className="h-full w-1/3 bg-primary-600 rounded-full animate-[bulk-import-indeterminate_1.2s_ease-in-out_infinite]"></div>
                    ) : (
                      <div
                        className="h-full bg-primary-600 rounded-full transition-all"
                        style={{ width: `${bulkImportUploadPercent}%` }}
                      ></div>
                    )}
                  </div>
                  <span role="status" aria-live="polite" className="sr-only">
                    {bulkImportProcessing
                      ? 'Upload complete. Creating teams, this may take a while for a large file.'
                      : ''}
                  </span>
                </div>
              )}

              {bulkImportError && (
                <div className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 p-3 mb-4">
                  <p className="text-sm text-red-700 dark:text-red-300">{bulkImportError}</p>
                </div>
              )}

              {bulkImportResult && bulkImportResult.rejected && (
                <div className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 p-3 mb-4">
                  <p className="text-sm font-medium text-red-800 dark:text-red-200 mb-2">
                    The entire import was rejected. No teams were created.
                  </p>
                  <ul className="list-disc list-inside space-y-1">
                    {bulkImportResult.results.map((wholeFileError, index) => (
                      <li key={index} className="text-sm text-red-700 dark:text-red-300">
                        {wholeFileError.error}
                        {wholeFileError.rowIds?.length > 0 && (
                          <> (rows: {wholeFileError.rowIds.join(', ')})</>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {bulkImportResult && !bulkImportResult.rejected && (
                <div>
                  <p className="text-sm text-gray-700 dark:text-gray-300 mb-2">
                    {bulkImportResult.successCount} succeeded, {bulkImportResult.failureCount} failed.
                  </p>
                  <div className="sm:hidden divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-lg">
                    {bulkImportResult.results.map((rowResult) => (
                      <div key={rowResult.row} className="p-4 space-y-1 text-sm">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-gray-900 dark:text-gray-100">Row {rowResult.row}</span>
                          {rowResult.success ? (
                            <span className="text-green-600 dark:text-green-400 font-medium">Success</span>
                          ) : (
                            <span className="text-red-600 dark:text-red-400 font-medium">Failed</span>
                          )}
                        </div>
                        <p className="text-gray-700 dark:text-gray-300 break-words">
                          {rowResult.success
                            ? `Team created (ID: ${rowResult.teamId})`
                            : rowResult.error}
                        </p>
                      </div>
                    ))}
                  </div>
                  <div className="hidden sm:block overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-700">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                          Row
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                          Status
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                          Message
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                      {bulkImportResult.results.map((rowResult) => (
                        <tr key={rowResult.row}>
                          <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100">
                            {rowResult.row}
                          </td>
                          <td className="px-3 py-2 text-sm">
                            {rowResult.success ? (
                              <span className="text-green-600 dark:text-green-400 font-medium">Success</span>
                            ) : (
                              <span className="text-red-600 dark:text-red-400 font-medium">Failed</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-sm text-gray-700 dark:text-gray-300">
                            {rowResult.success
                              ? `Team created (ID: ${rowResult.teamId})`
                              : rowResult.error}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'excludedDomains' && (
            <ExcludedDomainsManager />
          )}

          {activeTab === 'settingsBackup' && (
            <div className="space-y-8">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Export the portable, allow-listed settings and email templates to a file, or import
                them back into this or a fresh environment.
              </p>

              {/* Durability notice (Req 10.1, 10.2): UI-edited templates/settings
                  live only in the app database and depend on a DB backup or a
                  previously produced export to survive a database loss. */}
              <div className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 p-3">
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  Email templates and settings edited through this interface are stored only in the
                  application database &mdash; they are not written to any configuration file.
                  Recovering them after a database loss depends on a separate database backup or on
                  an export file you produced earlier.
                </p>
              </div>

              {/* --- Settings Export (task 8.1) --- */}
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Export settings
                </h3>

                {/* Secrets-excluded / not-a-DB-backup notice (Req 7.5). */}
                <div className="rounded border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/30 p-3">
                  <p className="text-sm text-blue-800 dark:text-blue-200">
                    This export <strong>excludes secrets</strong> (specifically the TAK Server
                    passphrase). It is a <strong>settings export, not a backup of domain data</strong>
                    &mdash; it does not include organisations, teams, members, channels, access
                    requests, or audit logs.
                  </p>
                </div>

                <div>
                  <button
                    onClick={handleExportSettings}
                    disabled={exporting}
                    className="btn-primary flex items-center gap-2 disabled:opacity-50"
                  >
                    <ArrowDownTrayIcon className="h-4 w-4" />
                    {exporting ? 'Exporting...' : 'Export settings'}
                  </button>
                </div>

                {/* Export failure (Req 7.4): generic message; the blob error body
                    is deliberately not parsed. */}
                {exportError && (
                  <div className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 p-3">
                    <p className="text-sm text-red-700 dark:text-red-300">{exportError}</p>
                  </div>
                )}
              </section>

              {/* --- Settings Import (task 8.2) --- */}
              <section className="space-y-3">
                <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Import settings
                </h3>

                {/* Secret-must-be-re-entered notice (Req 9.5). */}
                <div className="rounded border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/30 p-3">
                  <p className="text-sm text-blue-800 dark:text-blue-200">
                    Importing into a fresh environment does <strong>not</strong> restore the excluded
                    secret (the TAK Server passphrase); it must be re-entered separately.
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                  <input
                    ref={settingsImportFileInputRef}
                    type="file"
                    accept=".zip,.json,application/zip,application/json"
                    onChange={handleImportFileChange}
                    className="text-sm text-gray-900 dark:text-gray-100 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-primary-50 file:text-primary-700 dark:file:bg-primary-900 dark:file:text-primary-300"
                  />
                  <button
                    onClick={handleImportSettings}
                    disabled={!importFile || importing}
                    className="btn-primary flex items-center gap-2 disabled:opacity-50"
                  >
                    <ArrowUpTrayIcon className="h-4 w-4" />
                    {importing ? 'Importing...' : 'Import settings'}
                  </button>
                </div>

                {/* Client-side transform failure or generic transport error
                    (Req 8.6, 9.4). */}
                {importError && (
                  <div className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 p-3">
                    <p className="text-sm text-red-700 dark:text-red-300">{importError}</p>
                  </div>
                )}

                {/* Expected 400 rejection: list each Import_Problem and state
                    that nothing was changed (Req 9.2, 9.3). */}
                {importProblems.length > 0 && (
                  <div className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 p-3">
                    <p className="text-sm font-medium text-red-800 dark:text-red-200 mb-2">
                      The import was rejected. No settings were changed.
                    </p>
                    <ul className="list-disc list-inside space-y-1">
                      {importProblems.map((problem, index) => (
                        <li key={index} className="text-sm text-red-700 dark:text-red-300">
                          {problem}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Success confirmation with imported counts (Req 9.1). */}
                {importResult && (
                  <div className="rounded border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/30 p-3">
                    <p className="text-sm font-medium text-green-800 dark:text-green-200 mb-1">
                      Settings imported successfully.
                    </p>
                    <ul className="list-disc list-inside space-y-1 text-sm text-green-700 dark:text-green-300">
                      <li>System settings: {importResult.systemConfig}</li>
                      <li>Site settings: {importResult.siteConfig}</li>
                      <li>Email templates: {importResult.emailTemplates}</li>
                    </ul>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>


    </div>
  )
}