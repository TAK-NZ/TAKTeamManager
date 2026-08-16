import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildFolderTree } from './channelTree.js';

// Validates: Requirements 12.7

/**
 * Walk a built tree back down along `segments` (the folder names used to
 * build it, in order) and reconstruct the original folder-separated name by
 * rejoining every intermediate folder name plus the final leaf channel's
 * (rewritten) `nameField` value with `separator`. This is the "round trip"
 * check shared by the example tests and the property test below.
 */
function walkAndReconstruct(tree, segments, separator, nameField, channelId) {
  let current = tree;
  const pathParts = [];

  for (let i = 0; i < segments.length - 1; i++) {
    const folderName = segments[i];
    expect(current.folders).toHaveProperty(folderName);
    pathParts.push(folderName);
    current = current.folders[folderName];
  }

  const leafChannel = current.channels.find(c => c.id === channelId);
  expect(leafChannel).toBeDefined();
  pathParts.push(leafChannel[nameField]);

  return { reconstructed: pathParts.join(separator), leafChannel, node: current };
}

describe('buildFolderTree', () => {
  describe('example round trips (Requirements 12.7)', () => {
    it('nests a 3-level hierarchy two folders deep and rewrites the leaf nameField', () => {
      const separator = ' - ';
      const original = 'Region A - District B - Alpha Channel';
      const channels = [{ id: 'c1', display_name: original }];

      const tree = buildFolderTree(channels, separator);

      expect(Object.keys(tree.folders)).toEqual(['Region A']);
      expect(Object.keys(tree.folders['Region A'].folders)).toEqual(['District B']);

      const innermost = tree.folders['Region A'].folders['District B'];
      expect(innermost.channels).toHaveLength(1);
      expect(innermost.channels[0]).toMatchObject({
        id: 'c1',
        display_name: 'Alpha Channel'
      });

      const { reconstructed } = walkAndReconstruct(
        tree,
        ['Region A', 'District B', 'Alpha Channel'],
        separator,
        'display_name',
        'c1'
      );
      expect(reconstructed).toBe(original);
    });

    it('nests a 4+-level hierarchy three folders deep and rewrites the leaf nameField', () => {
      const separator = ' - ';
      const original = 'Region A - District B - Sub-District C - Alpha Channel';
      const channels = [{ id: 'c2', display_name: original }];

      const tree = buildFolderTree(channels, separator);

      expect(Object.keys(tree.folders)).toEqual(['Region A']);
      expect(Object.keys(tree.folders['Region A'].folders)).toEqual(['District B']);
      expect(Object.keys(tree.folders['Region A'].folders['District B'].folders)).toEqual(['Sub-District C']);

      const innermost = tree.folders['Region A'].folders['District B'].folders['Sub-District C'];
      expect(innermost.channels).toHaveLength(1);
      expect(innermost.channels[0]).toMatchObject({
        id: 'c2',
        display_name: 'Alpha Channel'
      });

      const { reconstructed } = walkAndReconstruct(
        tree,
        ['Region A', 'District B', 'Sub-District C', 'Alpha Channel'],
        separator,
        'display_name',
        'c2'
      );
      expect(reconstructed).toBe(original);
    });
  });

  describe('nameField parameter', () => {
    it('defaults to display_name when nameField is omitted', () => {
      const channels = [{ id: 'c3', display_name: 'Top Level - Leaf' }];
      const tree = buildFolderTree(channels, ' - ');

      expect(tree.folders['Top Level'].channels[0].display_name).toBe('Leaf');
    });

    it('uses an explicit override (name), matching GlobalChannels.jsx usage', () => {
      const channels = [{ id: 'c4', name: 'Top Level - Leaf' }];
      const tree = buildFolderTree(channels, ' - ', 'name');

      expect(tree.folders['Top Level'].channels[0].name).toBe('Leaf');
    });
  });

  // Feature: production-hardening, Property 7: Channel folder-path round trip
  // Validates: Requirements 12.7
  it('Property 7: Channel folder-path round trip', () => {
    const separator = ' - ';
    const segmentArb = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter(s => {
        const trimmed = s.trim();
        return trimmed.length > 0 && !trimmed.includes(separator) && trimmed === s;
      });

    fc.assert(
      fc.property(fc.array(segmentArb, { minLength: 1, maxLength: 6 }), segments => {
        const originalName = segments.join(separator);
        const channel = { id: 'prop-channel', display_name: originalName };

        const tree = buildFolderTree([channel], separator);

        let current = tree;
        const pathParts = [];
        for (let i = 0; i < segments.length - 1; i++) {
          const folderName = segments[i];
          if (!current.folders[folderName]) return false;
          pathParts.push(folderName);
          current = current.folders[folderName];
        }

        const leafChannel = current.channels.find(c => c.id === 'prop-channel');
        if (!leafChannel) return false;
        if (leafChannel.display_name !== segments[segments.length - 1]) return false;
        pathParts.push(leafChannel.display_name);

        return pathParts.join(separator) === originalName;
      }),
      { numRuns: 100 }
    );
  });
});
