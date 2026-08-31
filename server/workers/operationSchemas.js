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

  // Requirement 21.10 (task 40.1): enqueued by
  // `VendorChannelService.createVendorChannel` after inserting the
  // singleton `vendor_channels` row. `vendor_channel_id` is the newly
  // inserted row's id -- the Sync_Worker handler
  // `createVendorChannelGroup` (in `syncWorker.js`) creates a single
  // Authentik `VND` group (not a read/write pair, unlike BCH/region
  // channels) and, on success, UPDATEs `vendor_channels.authentik_group_id`
  // with the created group's Authentik pk.
  create_vendor_channel_group: {
    requiredFields: {
      vendor_channel_id: 'number'
    }
  },

  // Requirement 22.4/22.11 (task 42.1): enqueued by
  // `DeploymentChannelService.createDeploymentChannel` after inserting
  // the `deployment_channels` row, within the same transaction.
  // `deployment_channel_id` is the newly inserted row's id;
  // `channel_name` is the (already-validated) Deployment_Channel name --
  // either `Overseas - `-prefixed or matching the domestic
  // `[COUNTRY]-[FUNCTION]-[REGION]-[SUFFIX]` pattern. The Sync_Worker
  // handler `createDeploymentChannelGroup` (in `syncWorker.js`) creates a
  // single Authentik group for this channel -- mirroring the single-group
  // pattern used by `create_vendor_channel_group`/`create_region_channel_group`
  // rather than the read/write pair used by BCH channels, since neither
  // Requirement 22 nor `design.md`'s Section 18 calls for a
  // read/write split for deployment channels -- and, on success, UPDATEs
  // `deployment_channels.authentik_group_id` with the created group's pk.
  create_deployment_channel_group: {
    requiredFields: {
      deployment_channel_id: 'number',
      channel_name: 'string'
    }
  },

  // Requirement 22.8/22.9 (task 42.3): enqueued by
  // `DeploymentChannelService.deactivateExpired()` once per
  // newly-deactivated `deployment_channels` row, AFTER that row's
  // `is_active` has already been set to `false` and its
  // `channel_memberships` rows have already been deleted from the local
  // database. `channel_id` is the (still-existing, now-inactive) local
  // `deployment_channels.id`, kept only for logging/traceability --
  // mirroring `remove_team_channel_group`'s `channel_id` field -- since
  // the Sync_Worker handler `removeAllMembersFromGroup` (in
  // `syncWorker.js`) acts solely on `target_group_id`. `target_group_id`
  // is the channel's Authentik group id: bulk-removing every member from
  // that group is this operation's entire purpose.
  remove_all_members_from_group: {
    requiredFields: {
      channel_id: 'number',
      target_group_id: 'string'
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
  // The two discriminators are declared under `exactlyOneOf` rather than
  // `requiredFields`/`optionalFields`, because neither is required on its
  // own yet a payload carrying both (or neither) is ambiguous about what
  // to revoke and must be rejected up front rather than silently resolved
  // by the handler's branch order. `target_user_id` stays optional in both
  // shapes -- the device-scoped routes (task 19.4) always send it, the
  // team-level bulk enqueue still cannot. The handler branch that reads
  // `client_uid` is task 19.3; this entry only widens what validates.
  revoke_tak_certificates: {
    exactlyOneOf: {
      client_uid: 'string',
      tak_usernames: 'object'
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
  }
};
