/**
 * Operation payload schemas (Requirement 9.3).
 *
 * A small, per-`operation_type` map of the fields each Sync_Worker
 * operation handler (see `executeOperation`'s `switch` statement and each
 * handler method in `server/workers/syncWorker.js`) actually destructures
 * or reads off its `payload` parameter, along with each field's expected
 * JS type. This exists so `executeOperation` can validate a payload's
 * shape *before* dispatching to a handler (task 27.2), rather than only
 * checking `typeof operation.payload` as it does today.
 *
 * No schema library is used -- the set of operation types is small and
 * fixed, so a plain object is clearer and has no extra dependency.
 *
 * Shape of each entry:
 *
 *   {
 *     requiredFields: { <fieldName>: <expectedType>, ... },
 *     optionalFields: { <fieldName>: <expectedType>, ... },  // omitted entirely if none
 *     exactlyOneOf:   { <fieldName>: <expectedType>, ... }   // omitted entirely if none
 *   }
 *
 * `<expectedType>` is one of the strings `typeof` would return for a valid
 * value: `'string'`, `'number'`, `'boolean'`, or `'object'`.
 *
 * - `requiredFields`: a payload MUST contain every one of these fields,
 *   and each one's `typeof` must match the declared type, for the payload
 *   to be considered valid for that `operation_type`.
 * - `optionalFields`: a payload MAY omit these fields entirely (including
 *   `undefined`/absent-key); IF present, the field's `typeof` must still
 *   match the declared type. These fields are read by the handler (e.g.
 *   `bulk_operation_id` to update bulk-operation progress) but the handler
 *   does not fail when they are absent, so they are intentionally excluded
 *   from `requiredFields` per Requirement 9.3's focus on validating
 *   required fields.
 * - `exactlyOneOf` (feature device-management, Requirement 12.2/12.3):
 *   declares a set of MUTUALLY EXCLUSIVE discriminator fields, of which a
 *   valid payload MUST carry exactly one -- carrying none, or carrying two
 *   or more, is a validation failure. The one that IS present must match
 *   its declared type; the absent ones are not type-checked. This exists
 *   for operation types that accept more than one payload shape (today only
 *   `revoke_tak_certificates`, which accepts a device-scoped `client_uid`
 *   or a user-scoped `tak_usernames`) and lets the handler branch on which
 *   discriminator it received. An entry declaring `exactlyOneOf` MAY omit
 *   `requiredFields` entirely when no field is required across every shape.
 *   Entries WITHOUT an `exactlyOneOf` key are validated exactly as before.
 *
 * Every `operation_type` handled by `executeOperation`'s `switch`
 * statement MUST have a corresponding top-level entry here (enforced by
 * the completeness test in `operationSchemas.test.js`).
 */

module.exports = {
  add_user_to_group: {
    requiredFields: {
      target_user_id: 'number',
      target_group_id: 'string'
    }
  },

  remove_user_from_group: {
    requiredFields: {
      target_user_id: 'number',
      target_group_id: 'string'
    }
  },

  create_group: {
    requiredFields: {
      group_name: 'string'
    },
    optionalFields: {
      group_attributes: 'object'
    }
  },

  bulk_add_user_to_team: {
    requiredFields: {
      target_user_id: 'number',
      team_id: 'number',
      role: 'string'
    },
    optionalFields: {
      bulk_operation_id: 'number'
    }
  },

  // bch-channel-category: `category` ('BCH'/'UTL') is required --
  // GlobalChannelService.createBchChannel always supplies it (defaulting
  // to 'BCH' when the caller omits one), having already validated it
  // against the same two-value set the migration's CHECK constraint
  // enforces, before ever enqueueing this operation. Mirrors
  // create_region_channel_group's `tier` field exactly.
  //
  // Bugfix: `description` is now included, so createBchChannelGroups can
  // set `attributes.description` on the two Authentik groups it creates
  // -- it was missing entirely before, leaving a freshly created channel
  // with no description in Authentik until the next edit. Declared
  // OPTIONAL (never required): `POST /api/global-channels/bch`'s
  // `description` body field is itself optional, so a channel created
  // with no description at all is legitimate and must not fail payload
  // validation.
  create_bch_channel_groups: {
    requiredFields: {
      channel_name: 'string',
      category: 'string',
      service_account_username: 'string',
      service_account_password: 'string',
      bch_channel_id: 'number'
    },
    optionalFields: {
      description: 'string'
    }
  },

  // Bugfix (a BCH/UTL channel imported via "Sync Existing Channels" has
  // no service account): enqueued by
  // GlobalChannelService.provisionServiceAccount after it has already
  // written the new service_account_username/service_account_password
  // onto the channel's row. `read_group_id`/`write_group_id` are the
  // channel's ALREADY-KNOWN group ids (present on every BCH/UTL row
  // regardless of which path created it), passed through so the
  // Sync_Worker handler `provisionBchServiceAccount` can add the new
  // service account to both without its own extra database lookup --
  // both are declared OPTIONAL rather than required because a channel
  // discovered via Sync Existing Channels can, in principle, have a null
  // `write_group_id` if its sibling write group was never found in
  // Authentik (see syncExistingGlobalChannels's `writeGroup?.pk || null`
  // fallback) -- provisioning must not itself fail payload validation
  // over a pre-existing data gap it did not create.
  provision_bch_service_account: {
    requiredFields: {
      bch_channel_id: 'number',
      service_account_username: 'string',
      service_account_password: 'string'
    },
    optionalFields: {
      read_group_id: 'string',
      write_group_id: 'string'
    }
  },

  // Bugfix (BCH credentials modal: "cycle the password"): enqueued by
  // GlobalChannelService.rotateServiceAccountPassword after it has
  // already written the freshly generated encrypted password onto the
  // channel's row. The username is unchanged by a rotation but still
  // required here -- the Sync_Worker handler needs it to resolve the
  // existing Authentik service account to set the new password on.
  rotate_bch_service_account_password: {
    requiredFields: {
      bch_channel_id: 'number',
      service_account_username: 'string',
      service_account_password: 'string'
    }
  },

  // Bugfix (BCH credentials modal: "delete the service account"):
  // enqueued by GlobalChannelService.deleteServiceAccount after it has
  // already cleared the local service_account_id/username/password
  // columns. `service_account_id` (the Authentik user pk) is OPTIONAL --
  // preferred when known (an exact id lookup needs no search), but a
  // channel provisioned before that column was populated may only have
  // carried a username; the Sync_Worker handler falls back to a
  // username lookup when the id is absent.
  delete_bch_service_account: {
    requiredFields: {
      bch_channel_id: 'number',
      service_account_username: 'string'
    },
    optionalFields: {
      service_account_id: 'string'
    }
  },

  // region-channel-tiers: `tier` ('response'/'support') is required --
  // GlobalChannelService.createRegionChannel always supplies it, having
  // already validated it against the same two-value set the migration's
  // CHECK constraint enforces, before ever enqueueing this operation.
  create_region_channel_group: {
    requiredFields: {
      channel_name: 'string',
      region_channel_id: 'number',
      tier: 'string'
    }
  },

  // bch-channel-category: `category` is required here too --
  // GlobalChannelService.updateBchChannel reads the row's own stored
  // category back before enqueueing (category is immutable after
  // creation), so the worker's rename PATCH names the correct
  // tak_BCH.../tak_UTL... group.
  update_bch_channel_group: {
    requiredFields: {
      bch_channel_id: 'number',
      channel_name: 'string',
      category: 'string',
      description: 'string'
    }
  },

  update_region_channel_group: {
    requiredFields: {
      region_channel_id: 'number',
      channel_name: 'string',
      description: 'string'
    }
  },

  // `channel_id` arrives as a route-param STRING all the way through:
  // `DELETE /api/global-channels/:channelType/:channelId`
  // (`server/routes/globalChannels.js`) never parses `req.params.channelId`
  // to a number before passing it to
  // `GlobalChannelService.deleteGlobalChannel`, which enqueues this
  // operation with that same string value verbatim. Declaring `'number'`
  // here made every `delete_global_channel` operation fail payload
  // validation before ever reaching Authentik -- confirmed live, every
  // historical row of this type had failed with
  // `field "channel_id" has type "string", expected "number"`, so no
  // Global_Channel delete has ever actually removed its Authentik group.
  delete_global_channel: {
    requiredFields: {
      channel_id: 'string',
      channel_type: 'string'
    }
  },

  assign_user_to_global_channels: {
    requiredFields: {
      target_user_id: 'number'
    },
    optionalFields: {
      bulk_operation_id: 'number'
    }
  },

  deactivate_global_channel: {
    requiredFields: {
      channel_id: 'number'
    }
  },

  sync_existing_global_channels: {
    requiredFields: {
      synced_by: 'number'
    }
  },

  // region-channel-tiers: enqueued by PUT /api/teams/:teamId/channel-access
  // (server/routes/teams.js) once per tier that actually changed value.
  resync_org_channel_tier_access: {
    requiredFields: {
      organisation_id: 'number',
      tier: 'string'
    }
  },

  // Requirement 17.2 (task 36.2): enqueued as the fallback compensating
  // action by `POST /api/users/create-and-add`'s Phase 2 catch block WHEN
  // the local database transaction fails AFTER the Authentik user was
  // already created in Phase 1, AND the synchronous compensating
  // Authentik-user-delete attempt itself also fails. `authentik_user_id`
  // is the Authentik `pk` of the now-orphaned user (it exists in
  // Authentik but has no corresponding local `users` row), matching the
  // `users.authentik_user_id INTEGER` column type -- see the Sync_Worker
  // handler `cleanupOrphanedAuthentikUser` in `syncWorker.js`, which
  // retries the same delete call asynchronously.
  cleanup_orphaned_authentik_user: {
    requiredFields: {
      authentik_user_id: 'number'
    }
  },

  // Requirement 17.3/17.4 (task 36.3): enqueued once per channel by
  // `Team.delete`, after that channel's row (and its
  // `channel_memberships` rows) have already been deleted from the local
  // database within the same transaction. `channel_id` is the (now
  // deleted) local channel id, kept only for logging/traceability -- the
  // Sync_Worker handler `removeTeamChannelGroup` in `syncWorker.js` acts
  // solely on the `authentik_*_group_id` fields, since the local row no
  // longer exists to look them up from. All three group-id fields are
  // declared optional (rather than required) because a channel may have
  // been created with only a subset populated (e.g. the auto-created
  // primary team channel sets only `authentik_group_id`, never the
  // read/write pair) -- see `Team.createTeamChannel`/
  // `Channel.createCustomChannel`.
  // `authentik_group_id`/`authentik_read_group_id`/`authentik_write_group_id`
  // are Authentik group pks -- UUID STRINGS (`character varying(255)` on
  // `channels` in the baseline schema), never numbers. Declaring
  // `'number'` here made every `remove_team_channel_group` operation fail
  // payload validation before ever reaching Authentik -- confirmed live
  // against the dev database, every historical row of this type had
  // failed with `field "authentik_group_id" has type "string", expected
  // "number"`, so no Team deletion has ever actually cleaned up its
  // Authentik channel groups; they were silently orphaned instead.
  remove_team_channel_group: {
    requiredFields: {
      channel_id: 'number'
    },
    optionalFields: {
      authentik_group_id: 'string',
      authentik_read_group_id: 'string',
      authentik_write_group_id: 'string'
    }
  },

  // Bugfix (orphaned Authentik team groups): enqueued by
  // `Team.createTeamChannel`'s fallback path when the SYNCHRONOUS Authentik
  // group-create at team-creation time failed (e.g. a timeout/rate-limit
  // during a bulk-import burst), so the channel row was inserted with a
  // NULL `authentik_group_id`. The Sync_Worker handler
  // `reconcileTeamChannelGroup` create-or-reuses the group by
  // `authentik_group_name` and writes the resulting pk back onto the
  // channel row identified by `channel_id`. `channel_id` is the LIVE local
  // channel id (unlike `remove_team_channel_group`, whose row is already
  // deleted) so the handler can look it up and guard on its current
  // `authentik_group_id`. `authentik_group_name` is required (the handler
  // cannot create/reuse a group without it). `description` is optional --
  // it is only the group's attribute text; a missing one reconciles to an
  // empty description rather than failing the operation.
  reconcile_team_channel_group: {
    requiredFields: {
      channel_id: 'number',
      authentik_group_name: 'string'
    },
    optionalFields: {
      description: 'string'
    }
  },

  // Bugfix (Channels tab has no edit action, and no way to add/edit a
  // custom channel's Authentik/LDAP description): enqueued by
  // Channel.updateCustomChannel after updating the local `channels` row.
  // `description` is required (never nullable -- Channel.updateCustomChannel
  // normalizes a cleared field to '' before enqueueing, mirroring
  // update_bch_channel_group/update_region_channel_group's own required,
  // non-nullable `description` field above). Every group-id field is
  // OPTIONAL, exactly like remove_team_channel_group immediately above and
  // for the same reason: a custom channel always has all three at creation
  // (Channel.createCustomChannel), but declaring them required here would
  // be needlessly brittle against that assumption ever changing.
  update_channel_group: {
    requiredFields: {
      channel_id: 'number',
      description: 'string'
    },
    optionalFields: {
      authentik_group_id: 'string',
      authentik_read_group_id: 'string',
      authentik_write_group_id: 'string'
    }
  },

  // Requirement 26.6/26.7 (task 48.4): enqueued from three call sites --
  // (1) `TakCertificateRevocationService.revokeUserTakCertificates`'s
  // explicit single-user revoke action, (2)
  // `TeamMembershipService.removeUserFromTeam`'s existing "no teams
  // left" branch, and (3) `Team.delete`'s single bulk enqueue covering
  // every affected user across the team and its sub-teams. `tak_usernames`
  // is ALWAYS an array (even for the single-user call sites), so every
  // call site shares the same payload shape and the Sync_Worker handler
  // (task 48.5) can fetch `TakServerService.listCertificates()` exactly
  // once per operation regardless of how many usernames it carries,
  // consistent with the N+1-avoidance principle already established in
  // Requirement 11. `typeof [] === 'object'`, so `tak_usernames` is
  // declared with expected type `'object'` here -- the same convention
  // `group_attributes`/`member_permissions`-shaped fields elsewhere in
  // this map already use for non-primitive JSON values; per-element
  // string validation is left to the Sync_Worker handler itself.
  // `target_user_id` is optional: present for the single-user call
  // sites (1)/(2) for logging/traceability, omitted for the team-level
  // bulk call site (3), which has no single target user.
  //
  // Feature device-management, Requirement 12.2/12.3 (task 19.2): this
  // operation now accepts TWO payload shapes, and the device-scoped shape
  // is purely ADDITIVE -- the user-scoped shape above is unchanged and
  // still valid, so all three pre-existing call sites keep working without
  // modification and main-spec Requirement 26.6/26.7 is not broken:
  //
  //   device-scoped (this feature's per-Device Revoke action) -- revokes
  //   only the Live_Certificates carrying that one Client_Uid:
  //     { client_uid: 'ANDROID-842f08e120efdbe3', target_user_id: 42 }
  //
  //   user-scoped (the three pre-existing call sites) -- unchanged, still
  //   revokes every certificate the named users hold:
  //     { tak_usernames: ['alice'], target_user_id: 42 }
  //
  // The three discriminators are declared under `exactlyOneOf` rather than
  // `requiredFields`/`optionalFields`, because none is required on its
  // own yet a payload carrying more than one (or none) is ambiguous about
  // what to revoke and must be rejected up front rather than silently
  // resolved by the handler's branch order. `target_user_id` stays
  // optional across all three shapes -- the device-scoped routes (task
  // 19.4) always send it, the team-level bulk enqueue still cannot, and
  // this feature's Superseding_Revoke call site (below) has no single
  // target_user_id to attribute the operation to beyond its own
  // `created_by`. The handler branch that reads `client_uid` is task
  // 19.3; this entry only widens what validates.
  //
  // cert-expiry-notifications Requirement 8.2 (task 9.1): `cert_ids`,
  // a THIRD discriminator -- an array of TAK certificate ids (numbers) --
  // added for the Superseding_Revoke step `DeviceEnrollmentService
  // .#enqueueSupersedingRevoke` enqueues after a renewal mints a new
  // certificate on a `client_uid` that already held a live one. Unlike
  // `client_uid` (which resolves to every live certificate on that
  // Device) and `tak_usernames` (which resolves to every live
  // certificate a user holds across every Device), `cert_ids` already IS
  // the exact target certificate id set -- SyncWorker.resolveRevokeTargets
  // resolves it directly against the supplied array, with no catalog
  // matching needed at all, so a renewal's Superseding_Revoke can name
  // exactly the ONE superseded certificate it means to retire, never
  // every certificate on that client_uid (which would also revoke the
  // brand-new one just minted).
  revoke_tak_certificates: {
    exactlyOneOf: {
      client_uid: 'string',
      tak_usernames: 'object',
      cert_ids: 'object'
    },
    optionalFields: {
      target_user_id: 'number'
    }
  },

  // Requirement 9.5 (task 3.1): enqueued by `Team.create` WHILE
  // CloudTAK_Enabled is true, after the `teams` row is inserted.
  // `team_id` is the newly created Team's `teams.id`; the Sync_Worker
  // handler `createCloudTakGroup` (task 4.1) resolves the CloudTAK_Group
  // by name (`CloudTAKAgency<team_id>`) via Create_Or_Reuse, sets the
  // Agency_Attributes from the Team's current stored values, and
  // reconciles members to the Team's Direct_Admin_Set.
  create_cloudtak_group: {
    requiredFields: {
      team_id: 'number'
    }
  },

  // Requirement 9.5 (task 3.1): enqueued by `Team.update` (on a
  // name/description change), `Team.addMember`, the create-and-add admin
  // promotion in `server/routes/users.js`, and
  // `TeamMembershipService.removeUserFromTeam` WHILE CloudTAK_Enabled is
  // true. `team_id` is the affected Team's `teams.id`; the Sync_Worker
  // handler `updateCloudTakGroup` (task 4.1) resolves the CloudTAK_Group
  // by name via Create_Or_Reuse, sets the Agency_Attributes
  // authoritatively, and re-reconciles members to the current
  // Direct_Admin_Set (so the single operation type serves attribute and
  // membership changes alike).
  update_cloudtak_group: {
    requiredFields: {
      team_id: 'number'
    }
  },

  // Requirement 9.5 (task 3.1): enqueued by `Team.delete` inside the
  // deletion transaction (on the same client), before the Team row is
  // gone. `team_id` is the (now-deleted) Team's `teams.id`, kept in the
  // payload because the local row no longer exists to look up from -- the
  // Sync_Worker handler `deleteCloudTakGroup` (task 4.2) derives the group
  // name (`CloudTAKAgency<team_id>`) purely from `team_id`, resolves the
  // group by name in Authentik, DELETEs it, and treats a 404/absent group
  // as an already-satisfied no-op.
  delete_cloudtak_group: {
    requiredFields: {
      team_id: 'number'
    }
  },

  // Authentik scaling, Phase 2: the group-authoritative reconcile. Computes
  // an owned group's COMPLETE desired member set from the local DB and
  // writes it with a single full-replace group PATCH (see
  // server/services/OwnedGroupReconciler.js and
  // .kiro/steering/authentik-scaling.md). The Sync_Worker handler
  // `reconcileOwnedGroup` dispatches on `group_kind`:
  //   - 'team_channel' -> requires `channel_id` (a channels.id)
  //   - 'bch_read' / 'bch_write' -> requires `bch_channel_id`
  //   - 'region' -> requires `region_channel_id`
  //   - 'cloudtak' -> requires `team_id`
  // The per-kind id field cannot be expressed as a single `requiredFields`
  // entry (each kind carries a DIFFERENT id), so `group_kind` is the one
  // unconditionally-required field and the four id fields are declared
  // optional here; the handler enforces that the id matching the kind is
  // present (a missing one is a permanent payload defect, not a retry).
  // `dry_run_note` is a free-form optional string some enqueue sites may
  // attach for traceability; it never affects behaviour.
  reconcile_owned_group: {
    requiredFields: {
      group_kind: 'string'
    },
    optionalFields: {
      channel_id: 'number',
      bch_channel_id: 'number',
      region_channel_id: 'number',
      team_id: 'number',
      bulk_operation_id: 'number'
    }
  }
};
