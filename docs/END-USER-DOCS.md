# TAK Team Manager: A Guide for Members and Team Admins

This guide explains how to use TAK Team Manager day-to-day, from getting an account through to managing a team. It's written for two audiences:

- **Team members** — anyone with an account who is part of a team.
- **Team admins** — members who additionally manage a team (or a whole organisation and its sub-teams).

Some screens and buttons described here only exist if your deployment has certain optional features turned on (noted where relevant), and some are visible only to a Global Manager (your organisation's overall system administrator) rather than a regular team admin — those are called out explicitly.

## Getting Started

### Requesting access

If you don't have an account yet, go to the Request Access page (`/request-access`).

1. **Enter your email address.** If your team gave you a sign-up code (an 8-character code shaped like `XXXX-XXXX`), enter that too — it pre-selects your team so you don't have to find it in a list. You may also need to complete a quick, invisible spam check (reCAPTCHA).
2. **Check your email.** You'll receive a verification link. This step just confirms the email address is really yours — you haven't been approved for a team yet.
3. **Click the link and fill in your details.** You'll land back on the Request Access page with your name fields and a team dropdown (already locked in if you used a sign-up code). Add a short reason for requesting access, and accept the terms of service if shown.
4. **Wait for approval.** You'll see a "Request Submitted" confirmation. A team admin now needs to review and approve your request — there's no live status page, so just watch your inbox.

If your email's domain doesn't match any team, you'll be offered an "Organisation Interest" form instead — this tells the organisation's administrators that someone from your organisation wants access, even though no team exists for you yet.

If your link has expired, you'll see a "Link Expired" message with a link to start over.

### Logging in

Once your account is approved, log in by clicking the login button — you'll be redirected to your organisation's identity provider (Authentik) to sign in, then brought back to your Dashboard automatically. There's no separate password to manage inside TAK Team Manager itself.

To log out, use the menu in the top navigation bar. This also ends your identity-provider session, not just your session in this app.

## Your Dashboard

After logging in, your Dashboard is home base. It shows:

- **TAK Profile** — your callsign, your TAK role, your team's colour/function, your organisation, and your team (with a lock icon if your team is private). If you don't currently belong to a team, this reads literally "None" rather than being blank.
- **Pending Tasks** — a banner appears when you have something to act on and links you to the Tasks page. For admins that includes team access requests waiting for review; for everyone it includes your own device certificates due for renewal and any device connected under a callsign that needs correcting.
- **My Devices** *(if device management is enabled for your deployment)* — every TAK device you've enrolled, with its name, type, when it was last seen, and its status. You can:
  - Click **Add Device** to enroll a new one (see "Enrolling a Device" below).
  - **Revoke** a device you no longer use, right from this card.
  - If one of your devices' certificates is expiring soon or has already expired, a banner appears above the list linking you to **Renew now** — see "Certificate Renewal" below.
  - If a device is currently connected using a callsign that doesn't match the one assigned to you, it's flagged with an amber warning showing the callsign it connected with — see "Keeping Your Callsign Correct" below.
- **My Channels** — a searchable, expandable folder tree of every TAK channel you have access to, each one marked Read, Write, or Read-Write.

## Downloading and Enrolling a TAK Client

Getting a device onto the network is a two-step process: download the app, then enroll it.

### Step 1: Download

The Downloads page (`/downloads`) links to the official TAK client for your device's platform:

- **Android** — ATAK, via TAK.gov (recommended) or the Google Play Store.
- **iOS** — TAK Aware (recommended) or iTAK.
- **Windows** — WinTAK.
- **CloudTAK** — if your deployment offers it, a link appears below the download grid; this runs entirely in a web browser and needs no install at all, on any operating system.

### Step 2: Enroll

Open the Enrollment page (`/enrollment`, also linked from your Dashboard's "Add Device" button). You'll see a summary of what will be enrolled — your TAK Server address, username, callsign, colour, role, and how many active devices you already have — nothing is created yet at this point.

When you're ready, click **Generate Enrollment Data**. This creates a one-time enrollment code valid for 30 minutes, shown across four tabs:

- **ATAK** (Android) — if you're viewing this page on the Android device itself, you'll see a direct "Enroll this device now" link. Otherwise, open the TAK app on your Android device and scan the QR code shown here with a *different* device or camera (you can't scan your own screen).
- **TAK Aware** (iOS) — same QR code, with TAK Aware's own menu steps ("Connect to a TAK Server" → "Scan Android QR code").
- **iTAK** — its own QR code and iTAK-specific steps.
- **Manual / WinTAK** — if your client can't scan a QR code, this tab gives you everything to type in by hand: server address, port, username, and a password you can copy to your clipboard (it's never shown as plain text).

A countdown shows how long you have before the code expires. Your enrolled device's certificate is valid for about a year.

### Certificate Renewal and Expiry Emails

*(If your deployment has certificate-expiry notifications enabled.)*

As your device's certificate approaches expiry, you'll get an email reminder — the first one about 30 days out, with further reminders as the date gets closer if you haven't renewed yet. The email tells you which device it's about and when its certificate expires. To renew, go to the Enrollment page and generate a new enrollment the same way you did the first time — this issues a new certificate and automatically retires the one it replaces (as long as you only have one live device certificate at the time; with more than one, retire the old one yourself via Revoke).

If a device stopped being used a while ago and you don't need it anymore, don't bother renewing it — revoke its certificate instead, either from your Dashboard's "My Devices" card or from the Tasks page (see below).

For a team-owned device (one that belongs to the team rather than to any one person), the same kind of reminder email goes to the team's admins instead of to any individual, escalating to admins further up the organisation's hierarchy the closer the certificate gets to expiring.

### Keeping Your Callsign Correct

*(If your deployment has device management enabled.)*

You're assigned a callsign by TAK Team Manager (shown on your Dashboard's TAK Profile and on the Enrollment page). You're free to **add** to the end of it in your TAK client — for example `FENZ-STL-J.Doe (Tablet)` or `FENZ-STL-J.Doe (Drone)` — but the assigned part itself should stay unchanged.

If one of your devices connects using a callsign that changes the assigned part, the app notices and lets you know:

- The device is flagged with an amber warning on your Dashboard's "My Devices" card (showing the callsign it connected with), and it appears under **Callsign needs correcting** on the Tasks page, which also counts toward the pending-tasks badge.
- You'll also get a single email the first time it's noticed, showing your assigned callsign and the one the device connected with. You won't be emailed again about the same device unless you fix the callsign and it later drifts again.

To clear it, just set the callsign in your TAK client back to your assigned callsign (optionally with your own addition on the end) and reconnect. The warning clears on its own once the device connects with an acceptable callsign. Note this only applies to native TAK clients (ATAK, iTAK, WinTAK); CloudTAK/WebTAK manages your callsign for you, so it's never flagged.

## Team Admin: Managing Your Team

If you're a team admin, you'll see extra buttons and actions on your team's page (`/teams`, then click into your team) that a regular member doesn't see. A regular member can browse the same tabs read-only, but every action button described below is hidden for them.

You become a team admin either by being promoted by another admin, or by being an admin of an ancestor team above yours in the hierarchy (admin rights flow downward through sub-teams automatically).

### Finding your team

The Orgs & Teams page (`/teams`) lists every organisation and team you belong to, with quick counts for Members, Team Devices, Team Admins, and Sub-teams — click any of those counts to jump straight to that tab on the team's own page.

### Adding members

From your team's page, click **Add Member**. You have two options:

- **Create New User** — for someone brand new. Fill in their email, first and last name, and (depending on your organisation's settings) a callsign suffix. Their account and TAK credentials are created right away.
- **Add Existing User** — for someone who already has an account elsewhere and needs to join your team. You'll also get a chance to review and correct their name and callsign suffix before adding them.

### Managing members

Your team's **Members** tab lists everyone on the team. Each row has a set of actions:

- **Edit** — correct their name, TAK role, or callsign suffix.
- **Resend welcome email** — if someone missed or lost their original welcome email, this sends it again. You'll be asked to confirm before it sends.
- **Transfer** — move this member to a different team.
- **View Devices** *(if device management is enabled)* — see the TAK devices this member has enrolled, and revoke one on their behalf if needed.
- **Suspend account** — locks the member out and revokes every certificate they hold. Use this for a temporary situation (someone leaving under a cloud, an access review in progress) rather than someone leaving for good. Because revoking a certificate can't be undone, you'll need to type the member's exact username to confirm. **Unsuspend account** reverses the lockout (a plain confirmation, no typing required) but does not un-revoke any certificate — the member has to re-enroll to get a working one again.
- **Delete** — this is the one genuinely irreversible action here: it permanently removes their account everywhere, including from the identity provider. You'll need to type their email address to confirm before it happens. Use this only when someone is truly leaving for good, not as a way to remove them from just your team (use Transfer for that).

You may also see a text label instead of the usual row content if an account is **Suspended** or the system could no longer find the account in the identity provider (**Account not found**, meaning it's been orphaned — see below). An orphaned account's Suspend/Unsuspend actions disappear entirely, since there's no identity left to lock or unlock; its Remove/Delete action still works.

### Managing team admins

The **Team Admins** tab shows everyone with admin rights on your team. The only action here is **Remove as admin** — this takes away their admin rights but leaves their account and team membership completely untouched; they simply become a regular member again. You'll be asked to confirm first. To make someone an admin, use **Add Admin** from your team page's menu (this promotes an existing member).

### Managing team devices

*(Only if device management is enabled for your deployment.)*

The **Team Devices** tab is for devices that belong to the team itself rather than to any one person — a shared tablet or a vehicle-mounted radio, for example. From here you can enroll a new team device (the same QR-code flow described above, just bound to the team rather than to you), revoke an existing one's certificate, or suspend/unsuspend the device account the same way you would a member's.

### Managing channels

The **Channels** tab shows your team's TAK channels — its primary channel plus any custom ones — along with each channel's sync status and member count. You can create a new channel from your team's menu (up to 3 per team).

### Managing sub-teams

The **Sub-teams** tab lists any teams nested underneath yours. You can create a new sub-team from here (there's a maximum nesting depth, so the option disables itself once you've reached it), or delete an existing sub-team.

### Reviewing tasks and access requests

The **Tasks** page (`/tasks` — an old bookmark to `/requests` still gets you here) is visible to everyone, not just admins, and shows up to four sections depending on who you are:

- **My certificates needing renewal** — anyone with a device certificate that's expiring soon or already expired sees it here, with a link to renew it.
- **Team devices needing renewal** *(team admins and above)* — the same, but for devices belonging to any team you administer, with a Renew action right on the row.
- **Access requests** *(team admins and above)* — pending requests to review, as cards:
  - **New account requests** show the person's email, requested team, submission date, and their stated reason for requesting access. You can adjust their name and callsign suffix before approving. Click **Approve** to let them in, or **Deny** (you'll be asked to give a written reason, which gets emailed to them). If the email matches an account whose identity-provider record was previously lost (see "orphaned account" above), you'll see a notice that approving will reclaim that old account — history and all — instead of creating a brand-new one; you'll still need to assign it a team and any admin rights fresh, since those aren't restored automatically.
  - **Transfer requests** show a member moving from one team to another, who requested it, and a note that approving it will remove their admin rights on their old team if they had any.
- **Organisation Interest requests** *(Global Manager only)* — people from an organisation with no team yet, expressing interest.

## Organisation-Wide Views (Global Manager only)

A few areas are visible only to your organisation's Global Manager, not to a regular team admin:

- **Users** (`/users`) — an organisation-wide version of the Members tab, letting a Global Manager act on any user regardless of which team they're in.
- **Devices** (`/devices`) *(if device management is enabled)* — the device counterpart of Users: every team-owned device across the organisation in one list. A regular team admin can also reach this page, but can only act on devices belonging to a team they administer; a Global Manager can act on all of them.
- **Global Channels** — organisation-wide channel management across every channel type.
- **Audit Log** — a complete, unchangeable history of administrative actions taken across the whole system, with CSV export.
- **Admin/Settings** — site content text, email template editing, bulk import of team hierarchies, excluded sign-up domains, and export/import of settings (site content, branding, and email templates only — TAK Server configuration is managed by the deployment and is not part of export/import).

If you're a team admin without global rights, you won't see these in your navigation menu at all.

## Notifications You Might Receive

- **Email verification** — when you first request access, confirming your email address.
- **Welcome/approval email** — sent once your access request is approved, with your account details.
- **Denial email** — sent if your request is denied, including the admin's stated reason.
- **Resend welcome email** — an admin can trigger this again if you missed the original.
- **Certificate expiry reminder** *(if enabled for your deployment)* — sent as your own device's certificate approaches expiry, or to your team's admins for a team-owned device — see "Certificate Renewal and Expiry Emails" above.

## Using TAK Team Manager on Your Phone

The whole app works on mobile. Tables that would otherwise require side-scrolling on a small screen (like the Members, Users, or Devices lists) instead show as a stack of cards, and buttons are sized for a real tap rather than a precise click. Everything you can do on desktop, you can do on mobile — the layout just adapts.
