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
 *     optionalFields: { <fieldName>: <expectedType>, ... }   // omitted entirely if none
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

  create_bch_channel_groups: {
    requiredFields: {
      channel_name: 'string',
      service_account_username: 'string',
      service_account_password: 'string',
      bch_channel_id: 'number'
    }
  },

  create_region_channel_group: {
    requiredFields: {
      channel_name: 'string',
      region_channel_id: 'number'
    }
  },

  update_bch_channel_group: {
    requiredFields: {
      bch_channel_id: 'number',
      channel_name: 'string',
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

  delete_global_channel: {
    requiredFields: {
      channel_id: 'number',
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
  remove_team_channel_group: {
    requiredFields: {
      channel_id: 'number'
    },
    optionalFields: {
      authentik_group_id: 'number',
      authentik_read_group_id: 'number',
      authentik_write_group_id: 'number'
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
  revoke_tak_certificates: {
    requiredFields: {
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
