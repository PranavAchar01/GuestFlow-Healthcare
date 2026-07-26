import { runDrugAllergyCheck, runSafetyController } from '../safety-chain';
import { DraftOrder, PatientContext } from '@/types';
import { v4 as uuidv4 } from 'uuid';

// runDrugAllergyCheck is async (tries Apify, falls back to local DB).
// In CI with no APIFY_API_TOKEN it always uses the local interaction DB.

function makeTpaOrder(): DraftOrder {
  return {
    id: uuidv4(),
    type: 'medication',
    description: 'Alteplase (tPA) IV',
    urgency: 'stat',
    status: 'drafted',
    medication: { resourceType: 'MedicationRequest', medication: 'tPA (Alteplase)', dosage: '0.9 mg/kg IV', route: 'IV', status: 'draft' },
  };
}

function makeAspirinOrder(): DraftOrder {
  return {
    id: uuidv4(),
    type: 'medication',
    description: 'Aspirin 325mg PO',
    urgency: 'stat',
    status: 'drafted',
    medication: { resourceType: 'MedicationRequest', medication: 'Aspirin', dosage: '325mg', route: 'PO', status: 'draft' },
  };
}

function warfarinPatient(): PatientContext {
  return {
    patientId: 'PT-001', name: 'John Martinez', age: 68, sex: 'Male',
    allergies: ['Penicillin'],
    currentMedications: ['Warfarin 5mg daily', 'Lisinopril 10mg'],
    conditions: ['Atrial Fibrillation'],
  };
}

function noMedPatient(): PatientContext {
  return {
    patientId: 'PT-002', name: 'Jane Doe', age: 45, sex: 'Female',
    allergies: [], currentMedications: [], conditions: [],
  };
}

// ----- THE CRITICAL TEST: Warfarin + tPA = blocked -----
describe('runDrugAllergyCheck — Warfarin/tPA contraindication', () => {
  it('blocks tPA when patient is on Warfarin', async () => {
    const { orders, conflicts } = await runDrugAllergyCheck([makeTpaOrder()], warfarinPatient());

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].severity).toBe('contraindicated');
    expect(conflicts[0].drug).toBe('tPA');
    expect(conflicts[0].conflictsWith).toBe('Warfarin');
    expect(orders[0].status).toBe('blocked');
  });

  it('suggests mechanical thrombectomy as the alternative', async () => {
    const { orders } = await runDrugAllergyCheck([makeTpaOrder()], warfarinPatient());

    expect(orders[0].alternative).toBe('Emergency mechanical thrombectomy');
    expect(orders[0].safetyNotes).toMatch(/BLOCKED/);
  });
});

describe('runDrugAllergyCheck — allergy check', () => {
  it('clears safe orders with no interactions', async () => {
    const { orders, conflicts } = await runDrugAllergyCheck([makeAspirinOrder()], noMedPatient());

    expect(conflicts).toHaveLength(0);
    expect(orders[0].status).toBe('drafted');
  });
});

describe('runSafetyController', () => {
  it('issues SAFETY HOLD when contraindicated conflicts exist', async () => {
    const { orders: checkedOrders, conflicts } = await runDrugAllergyCheck([makeTpaOrder()], warfarinPatient());
    const { recommendation } = runSafetyController(checkedOrders, conflicts);

    expect(recommendation).toMatch(/SAFETY HOLD/);
    expect(recommendation).toMatch(/blocked/i);
  });

  it('adds an alternative procedure order for each blocked order with an alternative', async () => {
    const { orders: checkedOrders, conflicts } = await runDrugAllergyCheck([makeTpaOrder()], warfarinPatient());
    const { orders } = runSafetyController(checkedOrders, conflicts);

    const alternatives = orders.filter((o) => o.status === 'drafted' && o.type === 'procedure');
    expect(alternatives.length).toBeGreaterThanOrEqual(1);
    expect(alternatives[0].description).toBe('Emergency mechanical thrombectomy');
  });

  it('issues a warning (not SAFETY HOLD) for non-contraindicated conflicts', async () => {
    const ibuprofenOrder: DraftOrder = {
      id: uuidv4(), type: 'medication', description: 'Ibuprofen 400mg',
      urgency: 'routine', status: 'drafted',
      medication: { resourceType: 'MedicationRequest', medication: 'Ibuprofen', dosage: '400mg', route: 'PO', status: 'draft' },
    };
    const { orders: checkedOrders, conflicts } = await runDrugAllergyCheck([ibuprofenOrder], warfarinPatient());
    const { recommendation } = runSafetyController(checkedOrders, conflicts);

    expect(recommendation).toMatch(/WARNING/);
    expect(recommendation).not.toMatch(/SAFETY HOLD/);
  });

  it('clears all orders when no conflicts', async () => {
    const { orders: checkedOrders, conflicts } = await runDrugAllergyCheck([makeAspirinOrder()], noMedPatient());
    const { recommendation } = runSafetyController(checkedOrders, conflicts);

    expect(recommendation).toMatch(/cleared/i);
  });
});
