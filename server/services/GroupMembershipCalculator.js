const pool = require('../config/database');

class GroupMembershipCalculator {
  static async calculateUserGroups(userId) {
    // Get user's team and all parent teams
    const teamHierarchy = await this.getUserTeamHierarchy(userId);
    
    // Get all applicable rules
    const rules = await this.getActiveRules();
    
    // Calculate required groups based on rules
    const requiredGroups = new Set();
    
    for (const rule of rules) {
      const groups = await this.applyRule(rule, userId, teamHierarchy);
      groups.forEach(group => requiredGroups.add(group));
    }
    
    return Array.from(requiredGroups);
  }

  static async getUserTeamHierarchy(userId) {
    const query = `
      WITH RECURSIVE team_hierarchy AS (
        -- Base case: user's direct team
        SELECT t.id, t.name, t.parent_team_id, 0 as level
        FROM teams t
        JOIN team_memberships tm ON t.id = tm.team_id
        WHERE tm.user_id = $1
        
        UNION ALL
        
        -- Recursive case: parent teams
        SELECT t.id, t.name, t.parent_team_id, th.level + 1
        FROM teams t
        JOIN team_hierarchy th ON t.id = th.parent_team_id
      )
      SELECT * FROM team_hierarchy ORDER BY level
    `;
    
    const result = await pool.query(query, [userId]);
    return result.rows;
  }

  static async getActiveRules() {
    const query = `
      SELECT * FROM group_membership_rules 
      WHERE is_active = true 
      ORDER BY priority ASC
    `;
    
    const result = await pool.query(query);
    return result.rows;
  }

  static async applyRule(rule, userId, teamHierarchy) {
    const groups = [];
    
    switch (rule.rule_type) {
      case 'team_hierarchy':
        for (const team of teamHierarchy) {
          const groupName = rule.target_group_pattern.replace('{{team_name}}', team.name.toLowerCase().replace(/\s+/g, '_'));
          groups.push({
            name: groupName,
            permission: rule.permission_type
          });
        }
        break;
        
      case 'bch_channels':
        // Apply BCH channel rule based on target group pattern
        groups.push({
          name: rule.target_group_pattern,
          permission: rule.permission_type
        });
        break;
        
      case 'region_channels':
        // Apply region channel rule based on target group pattern
        groups.push({
          name: rule.target_group_pattern,
          permission: rule.permission_type
        });
        break;
    }
    
    return groups;
  }

  static async getBchChannels() {
    const query = 'SELECT * FROM bch_channels WHERE is_active = true';
    const result = await pool.query(query);
    return result.rows;
  }

  static async getRegionChannels() {
    const query = 'SELECT * FROM region_channels WHERE is_active = true';
    const result = await pool.query(query);
    return result.rows;
  }
}

module.exports = GroupMembershipCalculator;