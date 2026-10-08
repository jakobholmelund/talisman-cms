type Scalar = string | number | boolean | null;
/** The comparisons a `where` clause may make; which apply depends on the field's type. */
interface Operators {
    eq?: Scalar;
    ne?: Scalar;
    in?: Scalar[];
    lt?: Scalar;
    lte?: Scalar;
    gt?: Scalar;
    gte?: Scalar;
    /** Whether a relationship or array field holds the value. */
    contains?: Scalar;
    isNull?: boolean;
    /** Literal, case-insensitive substring on text/textarea fields; 1–200 characters. */
    text?: string;
}
/** `{ field: value }` means equality; `{ field: { op: value } }` names the comparison. */
type WhereClause = Record<string, Scalar | Operators>;
interface EntryQuery {
    where?: WhereClause;
    /** Field names, `-` for descending; at most two. */
    sort?: string | string[];
    /** Rows to skip, with `limit`; at most 10000. */
    offset?: number;
}

export type { EntryQuery as E, Operators as O, WhereClause as W };
