import { z } from 'zod';
import { TalismanEnv } from 'talisman-cms/client';

/**
 * Changes the product editor's variant configurator makes: save a variant value together with its
 * stock row, delete a value, or delete a group with its values. Each change is one D1 batch, so a
 * failure leaves nothing half-saved and a retry cannot create a second value. The batches write D1
 * directly, so no collection hooks run; the core's cached reads of the rows are cleared afterwards.
 */
/** A refused change, with the HTTP status and message the admin route answers. */
declare class VariantChangeError extends Error {
    status: number;
    /** `stale_record` when a loaded token no longer matches, which the admin recognises. */
    code?: string;
    constructor(status: number, message: string, code?: string);
}
declare const saveValueInput: z.ZodObject<{
    groupId: z.ZodString;
    value: z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        expectedUpdatedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodNumber]>>;
        value: z.ZodString;
        sku: z.ZodEffects<z.ZodNullable<z.ZodString>, string | null, string | null>;
        image: z.ZodEffects<z.ZodNullable<z.ZodString>, string | null, string | null>;
        priceOverride: z.ZodNullable<z.ZodNumber>;
    }, "strict", z.ZodTypeAny, {
        image: string | null;
        sku: string | null;
        value: string;
        priceOverride: number | null;
        id?: string | undefined;
        expectedUpdatedAt?: string | number | undefined;
    }, {
        image: string | null;
        sku: string | null;
        value: string;
        priceOverride: number | null;
        id?: string | undefined;
        expectedUpdatedAt?: string | number | undefined;
    }>;
    stock: z.ZodOptional<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        expectedUpdatedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodNumber]>>;
        quantity: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        quantity: number;
        id?: string | undefined;
        expectedUpdatedAt?: string | number | undefined;
    }, {
        quantity: number;
        id?: string | undefined;
        expectedUpdatedAt?: string | number | undefined;
    }>>;
}, "strict", z.ZodTypeAny, {
    value: {
        image: string | null;
        sku: string | null;
        value: string;
        priceOverride: number | null;
        id?: string | undefined;
        expectedUpdatedAt?: string | number | undefined;
    };
    groupId: string;
    stock?: {
        quantity: number;
        id?: string | undefined;
        expectedUpdatedAt?: string | number | undefined;
    } | undefined;
}, {
    value: {
        image: string | null;
        sku: string | null;
        value: string;
        priceOverride: number | null;
        id?: string | undefined;
        expectedUpdatedAt?: string | number | undefined;
    };
    groupId: string;
    stock?: {
        quantity: number;
        id?: string | undefined;
        expectedUpdatedAt?: string | number | undefined;
    } | undefined;
}>;
/** A request to the admin variants endpoint. */
declare const variantChangeSchema: z.ZodDiscriminatedUnion<"action", [z.ZodObject<{
    groupId: z.ZodString;
    value: z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        expectedUpdatedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodNumber]>>;
        value: z.ZodString;
        sku: z.ZodEffects<z.ZodNullable<z.ZodString>, string | null, string | null>;
        image: z.ZodEffects<z.ZodNullable<z.ZodString>, string | null, string | null>;
        priceOverride: z.ZodNullable<z.ZodNumber>;
    }, "strict", z.ZodTypeAny, {
        image: string | null;
        sku: string | null;
        value: string;
        priceOverride: number | null;
        id?: string | undefined;
        expectedUpdatedAt?: string | number | undefined;
    }, {
        image: string | null;
        sku: string | null;
        value: string;
        priceOverride: number | null;
        id?: string | undefined;
        expectedUpdatedAt?: string | number | undefined;
    }>;
    stock: z.ZodOptional<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        expectedUpdatedAt: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodNumber]>>;
        quantity: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        quantity: number;
        id?: string | undefined;
        expectedUpdatedAt?: string | number | undefined;
    }, {
        quantity: number;
        id?: string | undefined;
        expectedUpdatedAt?: string | number | undefined;
    }>>;
} & {
    action: z.ZodLiteral<"saveValue">;
}, "strict", z.ZodTypeAny, {
    value: {
        image: string | null;
        sku: string | null;
        value: string;
        priceOverride: number | null;
        id?: string | undefined;
        expectedUpdatedAt?: string | number | undefined;
    };
    action: "saveValue";
    groupId: string;
    stock?: {
        quantity: number;
        id?: string | undefined;
        expectedUpdatedAt?: string | number | undefined;
    } | undefined;
}, {
    value: {
        image: string | null;
        sku: string | null;
        value: string;
        priceOverride: number | null;
        id?: string | undefined;
        expectedUpdatedAt?: string | number | undefined;
    };
    action: "saveValue";
    groupId: string;
    stock?: {
        quantity: number;
        id?: string | undefined;
        expectedUpdatedAt?: string | number | undefined;
    } | undefined;
}>, z.ZodObject<{
    action: z.ZodLiteral<"deleteValue">;
    valueId: z.ZodString;
}, "strict", z.ZodTypeAny, {
    action: "deleteValue";
    valueId: string;
}, {
    action: "deleteValue";
    valueId: string;
}>, z.ZodObject<{
    action: z.ZodLiteral<"deleteGroup">;
    groupId: z.ZodString;
}, "strict", z.ZodTypeAny, {
    action: "deleteGroup";
    groupId: string;
}, {
    action: "deleteGroup";
    groupId: string;
}>]>;
type SaveVariantValueInput = z.input<typeof saveValueInput>;
/**
 * Create a value with its stock row, or update a value and, when the input has `stock`, its stock
 * quantity. A saved value and a saved stock row must come with the updatedAt the editor loaded; if
 * either row changed since, or a stock row appeared that the editor did not know, nothing is written.
 */
declare function saveVariantValue(env: TalismanEnv, input: SaveVariantValueInput): Promise<{
    value: {
        id: string;
        updatedAt: string;
    };
    stock: {
        id: string;
        quantity: number;
        updatedAt: string;
    } | null;
}>;
/**
 * Delete a value with its stock row and its parts list (the variant component rows that name it).
 * The shared components themselves stay.
 */
declare function deleteVariantValue(env: TalismanEnv, valueId: string): Promise<{
    valueId: string;
    deleted: {
        values: number;
        stockRows: number;
        partRows: number;
    };
}>;
/** Delete a group with every value it has, their stock rows and their parts lists. */
declare function deleteVariantGroup(env: TalismanEnv, groupId: string): Promise<{
    groupId: string;
    deleted: {
        values: number;
        stockRows: number;
        partRows: number;
    };
}>;
/** Validate an admin request body and run the change it names. */
declare function runVariantChange(env: TalismanEnv, body: unknown): Promise<{
    value: {
        id: string;
        updatedAt: string;
    };
    stock: {
        id: string;
        quantity: number;
        updatedAt: string;
    } | null;
} | {
    valueId: string;
    deleted: {
        values: number;
        stockRows: number;
        partRows: number;
    };
} | {
    groupId: string;
    deleted: {
        values: number;
        stockRows: number;
        partRows: number;
    };
}>;

export { type SaveVariantValueInput, VariantChangeError, deleteVariantGroup, deleteVariantValue, runVariantChange, saveVariantValue, variantChangeSchema };
