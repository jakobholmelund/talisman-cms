declare function fetchLiveEntry(options: {
    collection: string;
    version?: 'draft' | 'published';
}, filter: any): Promise<{
    id: any;
    data: any;
} | undefined>;
declare function fetchLiveCollection(options: {
    collection: string;
    version?: 'draft' | 'published';
}, filter?: any): Promise<{
    entries: {
        id: any;
        data: any;
    }[];
}>;

export { fetchLiveCollection, fetchLiveEntry };
