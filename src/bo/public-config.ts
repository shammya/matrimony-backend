import { z } from 'zod';

/**
 * An agency's `public_config`: the non-secret content of its public site. See PublicConfig
 * in docs/api/openapi.yaml for the contract.
 *
 * An operator types it into the database by hand and the database only checks that it is a
 * JSON object, so this is where its shape is enforced before it can be served. It is lenient
 * on purpose: one bad field is dropped and the rest is kept, so a typo cannot take an agency's
 * site down. Unknown fields are removed so nothing unplanned becomes public. It is strict
 * about anything that reaches CSS or a link.
 */
const text = z.string().max(2000);

const localizedText = z
  .object({ bn: text.optional().catch(undefined), en: text.optional().catch(undefined) })
  .catch({});

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

// An absolute https address, or a path on the site. Never http:, javascript:, data: or //host.
const httpsUrl = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  });
const assetUrl = z.union([
  httpsUrl,
  z
    .string()
    .max(2000)
    .regex(/^\/(?!\/)/),
]);

const phone = z.string().max(40);

const branch = z.object({
  name: localizedText,
  address: localizedText.optional(),
  phone: phone.optional().catch(undefined),
  mapUrl: httpsUrl.optional().catch(undefined),
});

const successStory = z.object({
  names: localizedText,
  story: localizedText.optional(),
  year: z.number().int().min(1900).max(2100).optional().catch(undefined),
});

/** Keeps the valid items (up to `max`) and drops the rest instead of rejecting the list. */
function lenientList<T extends z.ZodType>(item: T, max: number) {
  return z
    .array(z.unknown())
    .optional()
    .catch(undefined)
    .transform((items): z.output<T>[] =>
      (items ?? [])
        .flatMap((value) => {
          const result = item.safeParse(value);
          return result.success ? [result.data] : [];
        })
        .slice(0, max),
    );
}

const publicConfigSchema = z
  .object({
    name: z.string().max(200).optional().catch(undefined),
    branding: z
      .object({
        logoUrl: assetUrl.optional().catch(undefined),
        primaryColor: color.optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
    contact: z
      .object({
        phone: phone.optional().catch(undefined),
        email: z.string().max(200).optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
    home: z
      .object({ title: localizedText.optional(), subtitle: localizedText.optional() })
      .optional()
      .catch(undefined),
    about: localizedText.optional(),
    branches: lenientList(branch, 3),
    successStories: lenientList(successStory, 6),
  })
  // Anything that is not an object at all becomes an empty config.
  .catch({ branches: [], successStories: [] });

export type PublicConfig = z.output<typeof publicConfigSchema>;

export function parsePublicConfig(value: unknown): PublicConfig {
  return publicConfigSchema.parse(value);
}
