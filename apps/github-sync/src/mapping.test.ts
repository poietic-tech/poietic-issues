import { describe, expect, it } from 'vitest';
import {
  bodyWithMarker,
  changedFields,
  cleanBody,
  commentMarker,
  gitHubCommentBody,
  gitHubStateFields,
  issueMarker,
  projectKeyFor,
  projectNameFor,
  snapshotOfGitHub,
  stateOfCategory,
  stateOfGitHub,
} from './mapping.ts';

describe('mapping', () => {
  it('derives unique, valid project keys from repository names', () => {
    expect(projectKeyFor('poietic-bridge', new Set())).toBe('PB');
    expect(projectKeyFor('poietic-bridge', new Set(['PB', 'PB2']))).toBe('PB3');
    expect(projectKeyFor('tracker', new Set())).toBe('TRA');
    expect(projectKeyFor('a', new Set())).toBe('GHA');
    expect(projectKeyFor('3d-print-sketches', new Set())).toBe('PS');
    expect(projectKeyFor('---', new Set())).toBe('GH');
  });

  it('names projects in title case', () => {
    expect(projectNameFor('poietic-bridge')).toBe('Poietic Bridge');
    expect(projectNameFor('stix_rust')).toBe('Stix Rust');
    expect(projectNameFor('graphing-library')).toBe('Graphing Library');
    expect(projectNameFor('poietic.tech')).toBe('Poietic Tech');
    expect(projectNameFor('3d-print-sketches')).toBe('3d Print Sketches');
  });

  it('round-trips the issue marker and strips it from bodies', () => {
    const body = bodyWithMarker('Hello\n', 'iss_01abc');
    expect(body).toBe('Hello\n\n<!-- poietic-issues:iss_01abc -->');
    expect(issueMarker(body)).toBe('iss_01abc');
    expect(cleanBody(body)).toBe('Hello');
    expect(cleanBody(bodyWithMarker('', 'iss_01abc'))).toBe('');
    expect(cleanBody('a\r\nb  \n')).toBe('a\nb');
    expect(issueMarker('no marker')).toBeUndefined();
  });

  it('marks mirrored comments', () => {
    const body = gitHubCommentBody(
      { id: 'cmt_01xyz', body: 'Looks good' },
      { name: 'Ada', handle: 'ada' },
      'https://issues.example.test/i/PB-1',
    );
    expect(body).toContain('**Ada** (@ada)');
    expect(commentMarker(body)).toBe('cmt_01xyz');
  });

  it('maps states between GitHub and status categories', () => {
    expect(stateOfGitHub({ state: 'open' })).toBe('open');
    expect(stateOfGitHub({ state: 'closed', state_reason: 'completed' })).toBe('completed');
    expect(stateOfGitHub({ state: 'closed', state_reason: null })).toBe('completed');
    expect(stateOfGitHub({ state: 'closed', state_reason: 'not_planned' })).toBe('not_planned');
    expect(stateOfGitHub({ state: 'closed', state_reason: 'duplicate' })).toBe('not_planned');
    expect(stateOfCategory('started')).toBe('open');
    expect(stateOfCategory('backlog')).toBe('open');
    expect(stateOfCategory('completed')).toBe('completed');
    expect(stateOfCategory('canceled')).toBe('not_planned');
    expect(gitHubStateFields('not_planned')).toEqual({
      state: 'closed',
      state_reason: 'not_planned',
    });
    expect(gitHubStateFields('open')).toEqual({ state: 'open', state_reason: 'reopened' });
  });

  it('reports only the fields that changed, ignoring label case and order', () => {
    const base = snapshotOfGitHub({
      number: 1,
      title: 'T',
      body: null,
      state: 'open',
      html_url: 'https://github.com/a/b/issues/1',
      labels: [{ name: 'bug' }, 'Docs'],
    });
    expect(base.labels).toEqual(['bug', 'Docs']);
    expect(changedFields(base, { ...base, labels: ['docs', 'BUG'] })).toEqual({});
    expect(changedFields(base, { ...base, title: 'U', state: 'completed' })).toEqual({
      title: 'U',
      state: 'completed',
    });
  });
});
