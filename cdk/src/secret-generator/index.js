'use strict';

/**
 * CloudFormation custom-resource handler that populates a Secrets Manager
 * secret with a cryptographically-random base64-encoded 32-byte value
 * (`crypto.randomBytes(32).toString('base64')`) — the exact format
 * TAK Team Manager's CREDENTIAL_ENCRYPTION_KEY requires (it decodes the value
 * and rejects anything that is not exactly 32 bytes).
 *
 * On CREATE it writes a fresh value. On UPDATE and DELETE it is a NO-OP: the
 * key must stay stable for the life of the deployment, since rotating it would
 * make every already-stored ciphertext undecryptable. (The secret resource
 * itself is owned by CDK; this only fills in its value once.)
 */
const { SecretsManagerClient, PutSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const crypto = require('crypto');

exports.handler = async (event) => {
  const requestType = event.RequestType;
  const secretArn = event.ResourceProperties && event.ResourceProperties.SecretArn;
  const physicalId = event.PhysicalResourceId || `secret-generator-${secretArn}`;

  if (requestType === 'Delete' || requestType === 'Update') {
    // Preserve the existing value — never rotate.
    return { PhysicalResourceId: physicalId, Data: {} };
  }

  if (!secretArn) {
    throw new Error('SecretArn resource property is required');
  }

  const value = crypto.randomBytes(32).toString('base64');

  const client = new SecretsManagerClient();
  await client.send(new PutSecretValueCommand({
    SecretId: secretArn,
    SecretString: value
  }));

  return { PhysicalResourceId: physicalId, Data: {} };
};
