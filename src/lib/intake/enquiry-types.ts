import type { PracticeArea } from '@/lib/db/schema';

/**
 * The firm's public enquiry types, and how they map to practice areas.
 *
 * These are two different taxonomies and conflating them would break one or
 * the other:
 *
 *  - **Enquiry type** is what the firm advertises and what an enquirer
 *    recognises. Four options, fixed by the firm's own website form.
 *  - **Practice area** is how work is routed — availability rules, document
 *    templates, procedural stages, matter filing. Five values, fixed by the
 *    PRD (§139, AI-5).
 *
 * The mapping below follows the firm's own published descriptions, quoted
 * against each entry and verified on the live site on 2026-08-12 rather than
 * inferred from the labels. Two of them do not go where the name suggests:
 *
 *  - **Debt recovery is advertised under Corporate & Commercial**, not under
 *    Dispute Resolution. Reading the labels alone sends every unpaid invoice
 *    to the wrong team.
 *  - **Conveyancing is also under Corporate & Commercial**, while land
 *    acquisition and tenancy sit under Property & Land — so Corporate &
 *    Commercial has to be able to resolve to `land_property` too.
 *
 * One label therefore covers several practice areas, and the label alone
 * cannot decide. `defaultPracticeArea` is only the fallback for the no-JS
 * form, where there is no conversation to classify from; everywhere else the
 * agent's reading of what the person actually describes takes precedence.
 *
 * Note what this exposes: **debt recovery has no entry point of its own.** A
 * client with an unpaid invoice picks Corporate & Commercial alongside company
 * law and construction, so only the content of what they write files it
 * correctly.
 */

export interface EnquiryTypeOption {
  /** Stable id — stored, and used as the form value. */
  id: string;
  /** Exactly as the firm words it. */
  label: string;
  /** The firm's own description of what the type covers. */
  blurb: string;
  /** Where it lands when nothing else is known. */
  defaultPracticeArea: PracticeArea;
  /** Every practice area this type can legitimately resolve to. */
  resolvesTo: PracticeArea[];
}

export const ENQUIRY_TYPES: EnquiryTypeOption[] = [
  {
    id: 'family_matrimonial',
    label: 'Family and Matrimonial',
    // "divorce, custody, and family-related matters"
    blurb: 'Divorce, custody, and family-related matters.',
    defaultPracticeArea: 'family_matrimonial',
    resolvesTo: ['family_matrimonial'],
  },
  {
    id: 'corporate_commercial',
    label: 'Corporate & Commercial',
    // "construction law, conveyancing, business disputes, contracts, debt
    // recovery, and company law"
    blurb:
      'Construction law, conveyancing, business disputes, contracts, debt recovery, and company law.',
    defaultPracticeArea: 'corporate_disputes',
    // Debt recovery and conveyancing both live here, so this one type has to
    // be able to land in three different practice areas.
    resolvesTo: ['corporate_disputes', 'debt_recovery', 'land_property', 'general'],
  },
  {
    id: 'dispute_resolution',
    label: 'Dispute Resolution',
    // "litigation law ... contract breaches, insurance, corporate conflicts,
    // and damage claims through negotiation or court action"
    blurb:
      'Litigation: contract breaches, insurance, corporate conflicts, and damage claims — by negotiation or court action.',
    defaultPracticeArea: 'corporate_disputes',
    // A debt claim is also litigation, so it can arrive through this door too.
    resolvesTo: ['corporate_disputes', 'debt_recovery', 'land_property', 'general'],
  },
  {
    id: 'property_land',
    label: 'Property & Land',
    // "land acquisition, ownership rights, tenancy disputes, and resolving
    // land fraud issues"
    blurb: 'Land acquisition, ownership rights, tenancy disputes, and land fraud.',
    defaultPracticeArea: 'land_property',
    resolvesTo: ['land_property'],
  },
];

/**
 * The public label to use when speaking to an enquirer about a classified
 * matter — stated explicitly rather than derived, because two practice areas
 * share one label and derivation would depend on array order.
 *
 * Debt recovery is spoken of as Corporate & Commercial: that is where the firm
 * advertises it, and it is the heading the person read before they wrote in.
 */
const PUBLIC_LABEL: Record<PracticeArea, string> = {
  family_matrimonial: 'Family and Matrimonial',
  debt_recovery: 'Corporate & Commercial',
  corporate_disputes: 'Corporate & Commercial',
  land_property: 'Property & Land',
  general: 'General',
};

export type EnquiryTypeId = (typeof ENQUIRY_TYPES)[number]['id'];

export const ENQUIRY_TYPE_IDS = ENQUIRY_TYPES.map((t) => t.id) as [string, ...string[]];

export function enquiryTypeById(id: string | null | undefined): EnquiryTypeOption | null {
  if (!id) return null;
  return ENQUIRY_TYPES.find((t) => t.id === id) ?? null;
}

/** Where an enquiry lands when only the selected type is known. */
export function practiceAreaForEnquiryType(id: string | null | undefined): PracticeArea | null {
  return enquiryTypeById(id)?.defaultPracticeArea ?? null;
}

/** The public label to use when speaking to an enquirer about a classified matter. */
export function enquiryTypeLabelFor(area: PracticeArea): string {
  return PUBLIC_LABEL[area];
}

/**
 * True when what the enquirer picked and what the platform classified do not
 * agree — the signal a lawyer should look at before the consultation.
 */
export function isMismatched(selectedId: string | null, classified: PracticeArea | null): boolean {
  if (!selectedId || !classified) return false;
  const option = enquiryTypeById(selectedId);
  return option ? !option.resolvesTo.includes(classified) : false;
}
