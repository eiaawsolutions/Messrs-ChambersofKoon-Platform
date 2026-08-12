import { describe, expect, it } from 'vitest';
import PizZip from 'pizzip';
import { buildStarterDocx, STARTER_TEMPLATES } from './starter-templates';
import { parseTemplate } from './template';
import { assembleDocx } from './template';

/**
 * The starter templates are generated rather than committed as binaries, so
 * these tests stand in for opening each one in Word: a malformed zip or an
 * unescaped placeholder would otherwise only surface when a lawyer clicks
 * generate.
 */

describe('starter templates', () => {
  it.each(STARTER_TEMPLATES.map((t) => [t.name, t] as const))(
    '%s produces a readable .docx',
    (_name, template) => {
      const buffer = buildStarterDocx(template);

      // Zip magic — the same check the revision upload applies.
      expect(buffer[0]).toBe(0x50);
      expect(buffer[1]).toBe(0x4b);

      const zip = new PizZip(buffer);
      expect(zip.file('word/document.xml')).toBeTruthy();
      expect(zip.file('[Content_Types].xml')).toBeTruthy();
      expect(zip.file('_rels/.rels')).toBeTruthy();
    },
  );

  it.each(STARTER_TEMPLATES.map((t) => [t.name, t] as const))(
    '%s exposes both placeholder namespaces',
    (_name, template) => {
      const { schema } = parseTemplate(buildStarterDocx(template));

      expect(schema.deterministic.length).toBeGreaterThan(0);
      expect(schema.ai.length).toBeGreaterThan(0);

      // FR-4.2: the two namespaces never overlap, or a model could supply a
      // party name.
      const deterministicNames = new Set(schema.deterministic.map((f) => f.name));
      for (const block of schema.ai) {
        expect(deterministicNames.has(block.name)).toBe(false);
      }
    },
  );

  it('carries no drafted clause wording — every narrative block is an AI block', () => {
    for (const template of STARTER_TEMPLATES) {
      const { schema } = parseTemplate(buildStarterDocx(template));
      // Each template must delegate its substantive content, not ship it.
      expect(schema.ai.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('marks every template as a scaffold to be replaced', () => {
    for (const template of STARTER_TEMPLATES) {
      const banner = template.body[0];
      expect(banner?.style).toBe('note');
      expect(banner?.text).toContain('STARTER TEMPLATE');
    }
  });

  it('renders with deterministic values without leaving placeholders behind', () => {
    const template = STARTER_TEMPLATES[0]!;
    const buffer = buildStarterDocx(template);
    const { schema } = parseTemplate(buffer);

    const deterministic = Object.fromEntries(
      schema.deterministic.map((f) => [f.name, `«${f.name}»`]),
    );
    const aiBlocks = Object.fromEntries(schema.ai.map((b) => [b.name, 'drafted text']));

    const assembled = assembleDocx({ templateBuffer: buffer, deterministic, aiBlocks });
    expect(assembled.missingDeterministic).toEqual([]);

    const rendered = new PizZip(assembled.buffer).file('word/document.xml')?.asText() ?? '';
    expect(rendered).toContain('«clientName»');
    expect(rendered).toContain('drafted text');
    expect(rendered).not.toContain('{clientName}');
  });
});
