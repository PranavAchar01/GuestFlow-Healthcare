import { fallbackStructuring } from '../structuring-chain';

describe('fallbackStructuring', () => {
  it('extracts vitals from a stroke transcript', () => {
    const transcript = '68 year old male, suspected stroke, left-side paralysis, onset 20 minutes ago. Heart rate 92, blood pressure 168/94, SpO2 96%, GCS 13.';
    const result = fallbackStructuring(transcript);

    expect(result.chiefComplaint).toBe('Suspected Stroke');
    expect(result.vitals.heartRate).toBe(92);
    expect(result.vitals.bloodPressure).toBe('168/94');
    expect(result.vitals.spO2).toBe(96);
    expect(result.vitals.gcs).toBe(13);
  });

  it('extracts FHIR observations for present vitals', () => {
    const transcript = 'Heart rate 88, blood pressure 130/80, SpO2 98%, respiratory rate 18.';
    const result = fallbackStructuring(transcript);

    const codes = result.observations.map((o) => o.code);
    expect(codes).toContain('8867-4');  // heart rate
    expect(codes).toContain('85354-9'); // blood pressure
    expect(codes).toContain('2708-6');  // SpO2
    expect(codes).toContain('9279-1');  // respiratory rate
    expect(result.observations.every((o) => o.resourceType === 'Observation')).toBe(true);
  });

  it('detects left-sided hemiparesis observation', () => {
    const transcript = 'Patient presents with left-sided paralysis and facial droop.';
    const result = fallbackStructuring(transcript);

    const hemi = result.observations.find((o) => o.code === 'G81.9');
    expect(hemi).toBeDefined();
    expect(hemi?.display).toBe('Left-sided Hemiparesis');
  });

  it('classifies chest pain as suspected MI', () => {
    const transcript = 'Patient with severe chest pain, onset 45 minutes ago.';
    const result = fallbackStructuring(transcript);

    expect(result.chiefComplaint).toBe('Chest Pain / Suspected MI');
    const cond = result.conditions.find((c) => c.code === 'I21.9');
    expect(cond).toBeDefined();
    expect(cond?.severity).toBe('severe');
  });

  it('records symptom onset when mentioned', () => {
    const transcript = 'Onset 20 minutes ago.';
    const result = fallbackStructuring(transcript);

    const onset = result.observations.find((o) => o.code === 'ONSET');
    expect(onset).toBeDefined();
    expect(onset?.value).toContain('20');
  });

  it('returns unknown complaint for unrecognised transcript', () => {
    const result = fallbackStructuring('Patient is feeling unwell.');
    expect(result.chiefComplaint).toBe('Undetermined');
    expect(result.narrative).toBe('Patient is feeling unwell.');
  });

  it('FHIR conditions include resourceType field', () => {
    const result = fallbackStructuring('Suspected stroke.');
    expect(result.conditions.every((c) => c.resourceType === 'Condition')).toBe(true);
  });
});
