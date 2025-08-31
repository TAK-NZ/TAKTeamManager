const pool = require('../config/database');

class EventPublisher {
  static async publishOperation(operationType, payload, createdBy = null) {
    const query = `
      INSERT INTO sync_operations (operation_type, target_user_id, target_group_id, payload, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `;
    
    const result = await pool.query(query, [
      operationType,
      payload.target_user_id || null,
      payload.target_group_id || null,
      JSON.stringify(payload),
      createdBy
    ]);
    
    return result.rows[0].id;
  }

  static async publishBulkOperation(operationName, totalItems, createdBy) {
    const query = `
      INSERT INTO bulk_operations (operation_name, total_items, created_by)
      VALUES ($1, $2, $3)
      RETURNING id
    `;
    
    const result = await pool.query(query, [operationName, totalItems, createdBy]);
    return result.rows[0].id;
  }
}

module.exports = EventPublisher;