const CallsignService = require('./CallsignService');

describe('CallsignService.assembleCallsign', () => {
  it('joins all three segments with a single dash when all are present', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: 'FENZ',
      teamSegmentPrefixes: ['CB', 'ST40'],
      nameSegment: 'J.Doe'
    });

    expect(result).toBe('FENZ-CBST40-J.Doe');
  });

  it('omits the Organisation segment and its adjacent dash when it is empty', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: '',
      teamSegmentPrefixes: ['CB', 'ST40'],
      nameSegment: 'J.Doe'
    });

    expect(result).toBe('CBST40-J.Doe');
  });

  it('treats a null Organisation segment the same as an empty one', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: null,
      teamSegmentPrefixes: ['CB'],
      nameSegment: 'J.Doe'
    });

    expect(result).toBe('CB-J.Doe');
  });

  it('omits the Team segment and its adjacent dash when teamSegmentPrefixes is empty', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: 'FENZ',
      teamSegmentPrefixes: [],
      nameSegment: 'J.Doe'
    });

    expect(result).toBe('FENZ-J.Doe');
  });

  it('omits the Team segment when every element is an empty string (joins to an empty string)', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: 'FENZ',
      teamSegmentPrefixes: ['', ''],
      nameSegment: 'J.Doe'
    });

    expect(result).toBe('FENZ-J.Doe');
  });

  it('treats an undefined teamSegmentPrefixes array the same as an empty one', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: 'FENZ',
      teamSegmentPrefixes: undefined,
      nameSegment: 'J.Doe'
    });

    expect(result).toBe('FENZ-J.Doe');
  });

  it('omits the Name segment and its adjacent dash when it is empty', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: 'FENZ',
      teamSegmentPrefixes: ['CB'],
      nameSegment: ''
    });

    expect(result).toBe('FENZ-CB');
  });

  it('joins multiple team-level prefixes with no separator', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: '',
      teamSegmentPrefixes: ['CB', 'ST40'],
      nameSegment: ''
    });

    expect(result).toBe('CBST40');
  });

  it('returns just the Organisation segment when it is the only one present', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: 'FENZ',
      teamSegmentPrefixes: [],
      nameSegment: ''
    });

    expect(result).toBe('FENZ');
  });

  it('returns just the Team segment when it is the only one present', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: '',
      teamSegmentPrefixes: ['CB', 'ST40'],
      nameSegment: ''
    });

    expect(result).toBe('CBST40');
  });

  it('returns just the Name segment when it is the only one present, with no leading dash', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: '',
      teamSegmentPrefixes: [],
      nameSegment: 'J.Doe'
    });

    expect(result).toBe('J.Doe');
  });

  it('returns an empty string when all three segments are empty', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: '',
      teamSegmentPrefixes: [],
      nameSegment: ''
    });

    expect(result).toBe('');
  });

  it('returns an empty string when all three segments are null/undefined', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: null,
      teamSegmentPrefixes: undefined,
      nameSegment: undefined
    });

    expect(result).toBe('');
  });
});

describe('CallsignService.computeDefaultCallsignSuffix', () => {
  it('computes a full_name suffix as "First Last" sanitized', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('John', 'Doe', 'full_name');
    expect(result).toBe('John-Doe');
  });

  it('computes a first_initial_last suffix as initial+space+last sanitized', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('John', 'Doe', 'first_initial_last');
    expect(result).toBe('J-Doe');
  });

  it('falls back to just firstName for first_initial_last when lastName is empty', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('John', '', 'first_initial_last');
    expect(result).toBe('John');
  });

  it('computes a first_last_initial suffix as first+space+initial sanitized', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('John', 'Doe', 'first_last_initial');
    expect(result).toBe('John-D');
  });

  it('falls back to just firstName for first_last_initial when lastName is empty', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('John', '', 'first_last_initial');
    expect(result).toBe('John');
  });

  it('computes a first_initial_dot_last suffix as "J.Doe" with the dot preserved', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('John', 'Doe', 'first_initial_dot_last');
    expect(result).toBe('J.Doe');
  });

  it('falls back to just firstName for first_initial_dot_last when lastName is empty', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('John', '', 'first_initial_dot_last');
    expect(result).toBe('John');
  });

  it('returns null unconditionally for user_defined', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('John', 'Doe', 'user_defined');
    expect(result).toBeNull();
  });

  it('falls back to full_name-style formatting for an unrecognized format value', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('John', 'Doe', 'some_unknown_format');
    expect(result).toBe('John-Doe');
  });

  it('trims firstName/lastName before formatting', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('  John  ', '  Doe  ', 'full_name');
    expect(result).toBe('John-Doe');
  });

  it('replaces a disallowed character (apostrophe) with a single dash', () => {
    const result = CallsignService.computeDefaultCallsignSuffix("O'Brien", 'Doe', 'first_initial_last');
    // rawSuffix before sanitization: "O Doe" (first initial "O" + space + "Doe")
    expect(result).toBe('O-Doe');
  });

  it('replaces each disallowed character individually rather than collapsing runs', () => {
    // full_name for a name containing an apostrophe: "Mary Jane O'Brien-Smith"
    // first_name "Mary  Jane" (double space) -> trimmed still has internal double space
    const result = CallsignService.computeDefaultCallsignSuffix('Mary  Jane', "O'Brien", 'full_name');
    // rawSuffix: "Mary  Jane O'Brien" -> each disallowed char (2 spaces, 1 space, apostrophe)
    // replaced individually with '-': "Mary--Jane-O-Brien"
    expect(result).toBe('Mary--Jane-O-Brien');
  });

  it('preserves the synthesized dot in first_initial_dot_last through sanitization', () => {
    const result = CallsignService.computeDefaultCallsignSuffix("Jo'sh", "O'Brien", 'first_initial_dot_last');
    // rawSuffix: "J.O'Brien" -> apostrophe replaced with '-', dot preserved
    expect(result).toBe("J.O-Brien");
  });

  it('preserves an already-hyphenated last name in full_name formatting', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('Anne', 'Smith-Jones', 'full_name');
    expect(result).toBe('Anne-Smith-Jones');
  });
});
