(globalThis.TURBOPACK = globalThis.TURBOPACK || []).push([typeof document === "object" ? document.currentScript : undefined, {

"[turbopack]/browser/dev/hmr-client/hmr-client.ts [client] (ecmascript)": ((__turbopack_context__) => {
"use strict";

var { g: global, __dirname } = __turbopack_context__;
{
/// <reference path="../../../shared/runtime-types.d.ts" />
/// <reference path="../../runtime/base/dev-globals.d.ts" />
/// <reference path="../../runtime/base/dev-protocol.d.ts" />
/// <reference path="../../runtime/base/dev-extensions.ts" />
__turbopack_context__.s({
    "connect": (()=>connect),
    "setHooks": (()=>setHooks),
    "subscribeToUpdate": (()=>subscribeToUpdate)
});
function connect({ addMessageListener, sendMessage, onUpdateError = console.error }) {
    addMessageListener((msg)=>{
        switch(msg.type){
            case "turbopack-connected":
                handleSocketConnected(sendMessage);
                break;
            default:
                try {
                    if (Array.isArray(msg.data)) {
                        for(let i = 0; i < msg.data.length; i++){
                            handleSocketMessage(msg.data[i]);
                        }
                    } else {
                        handleSocketMessage(msg.data);
                    }
                    applyAggregatedUpdates();
                } catch (e) {
                    console.warn("[Fast Refresh] performing full reload\n\n" + "Fast Refresh will perform a full reload when you edit a file that's imported by modules outside of the React rendering tree.\n" + "You might have a file which exports a React component but also exports a value that is imported by a non-React component file.\n" + "Consider migrating the non-React component export to a separate file and importing it into both files.\n\n" + "It is also possible the parent component of the component you edited is a class component, which disables Fast Refresh.\n" + "Fast Refresh requires at least one parent function component in your React tree.");
                    onUpdateError(e);
                    location.reload();
                }
                break;
        }
    });
    const queued = globalThis.TURBOPACK_CHUNK_UPDATE_LISTENERS;
    if (queued != null && !Array.isArray(queued)) {
        throw new Error("A separate HMR handler was already registered");
    }
    globalThis.TURBOPACK_CHUNK_UPDATE_LISTENERS = {
        push: ([chunkPath, callback])=>{
            subscribeToChunkUpdate(chunkPath, sendMessage, callback);
        }
    };
    if (Array.isArray(queued)) {
        for (const [chunkPath, callback] of queued){
            subscribeToChunkUpdate(chunkPath, sendMessage, callback);
        }
    }
}
const updateCallbackSets = new Map();
function sendJSON(sendMessage, message) {
    sendMessage(JSON.stringify(message));
}
function resourceKey(resource) {
    return JSON.stringify({
        path: resource.path,
        headers: resource.headers || null
    });
}
function subscribeToUpdates(sendMessage, resource) {
    sendJSON(sendMessage, {
        type: "turbopack-subscribe",
        ...resource
    });
    return ()=>{
        sendJSON(sendMessage, {
            type: "turbopack-unsubscribe",
            ...resource
        });
    };
}
function handleSocketConnected(sendMessage) {
    for (const key of updateCallbackSets.keys()){
        subscribeToUpdates(sendMessage, JSON.parse(key));
    }
}
// we aggregate all pending updates until the issues are resolved
const chunkListsWithPendingUpdates = new Map();
function aggregateUpdates(msg) {
    const key = resourceKey(msg.resource);
    let aggregated = chunkListsWithPendingUpdates.get(key);
    if (aggregated) {
        aggregated.instruction = mergeChunkListUpdates(aggregated.instruction, msg.instruction);
    } else {
        chunkListsWithPendingUpdates.set(key, msg);
    }
}
function applyAggregatedUpdates() {
    if (chunkListsWithPendingUpdates.size === 0) return;
    hooks.beforeRefresh();
    for (const msg of chunkListsWithPendingUpdates.values()){
        triggerUpdate(msg);
    }
    chunkListsWithPendingUpdates.clear();
    finalizeUpdate();
}
function mergeChunkListUpdates(updateA, updateB) {
    let chunks;
    if (updateA.chunks != null) {
        if (updateB.chunks == null) {
            chunks = updateA.chunks;
        } else {
            chunks = mergeChunkListChunks(updateA.chunks, updateB.chunks);
        }
    } else if (updateB.chunks != null) {
        chunks = updateB.chunks;
    }
    let merged;
    if (updateA.merged != null) {
        if (updateB.merged == null) {
            merged = updateA.merged;
        } else {
            // Since `merged` is an array of updates, we need to merge them all into
            // one, consistent update.
            // Since there can only be `EcmascriptMergeUpdates` in the array, there is
            // no need to key on the `type` field.
            let update = updateA.merged[0];
            for(let i = 1; i < updateA.merged.length; i++){
                update = mergeChunkListEcmascriptMergedUpdates(update, updateA.merged[i]);
            }
            for(let i = 0; i < updateB.merged.length; i++){
                update = mergeChunkListEcmascriptMergedUpdates(update, updateB.merged[i]);
            }
            merged = [
                update
            ];
        }
    } else if (updateB.merged != null) {
        merged = updateB.merged;
    }
    return {
        type: "ChunkListUpdate",
        chunks,
        merged
    };
}
function mergeChunkListChunks(chunksA, chunksB) {
    const chunks = {};
    for (const [chunkPath, chunkUpdateA] of Object.entries(chunksA)){
        const chunkUpdateB = chunksB[chunkPath];
        if (chunkUpdateB != null) {
            const mergedUpdate = mergeChunkUpdates(chunkUpdateA, chunkUpdateB);
            if (mergedUpdate != null) {
                chunks[chunkPath] = mergedUpdate;
            }
        } else {
            chunks[chunkPath] = chunkUpdateA;
        }
    }
    for (const [chunkPath, chunkUpdateB] of Object.entries(chunksB)){
        if (chunks[chunkPath] == null) {
            chunks[chunkPath] = chunkUpdateB;
        }
    }
    return chunks;
}
function mergeChunkUpdates(updateA, updateB) {
    if (updateA.type === "added" && updateB.type === "deleted" || updateA.type === "deleted" && updateB.type === "added") {
        return undefined;
    }
    if (updateA.type === "partial") {
        invariant(updateA.instruction, "Partial updates are unsupported");
    }
    if (updateB.type === "partial") {
        invariant(updateB.instruction, "Partial updates are unsupported");
    }
    return undefined;
}
function mergeChunkListEcmascriptMergedUpdates(mergedA, mergedB) {
    const entries = mergeEcmascriptChunkEntries(mergedA.entries, mergedB.entries);
    const chunks = mergeEcmascriptChunksUpdates(mergedA.chunks, mergedB.chunks);
    return {
        type: "EcmascriptMergedUpdate",
        entries,
        chunks
    };
}
function mergeEcmascriptChunkEntries(entriesA, entriesB) {
    return {
        ...entriesA,
        ...entriesB
    };
}
function mergeEcmascriptChunksUpdates(chunksA, chunksB) {
    if (chunksA == null) {
        return chunksB;
    }
    if (chunksB == null) {
        return chunksA;
    }
    const chunks = {};
    for (const [chunkPath, chunkUpdateA] of Object.entries(chunksA)){
        const chunkUpdateB = chunksB[chunkPath];
        if (chunkUpdateB != null) {
            const mergedUpdate = mergeEcmascriptChunkUpdates(chunkUpdateA, chunkUpdateB);
            if (mergedUpdate != null) {
                chunks[chunkPath] = mergedUpdate;
            }
        } else {
            chunks[chunkPath] = chunkUpdateA;
        }
    }
    for (const [chunkPath, chunkUpdateB] of Object.entries(chunksB)){
        if (chunks[chunkPath] == null) {
            chunks[chunkPath] = chunkUpdateB;
        }
    }
    if (Object.keys(chunks).length === 0) {
        return undefined;
    }
    return chunks;
}
function mergeEcmascriptChunkUpdates(updateA, updateB) {
    if (updateA.type === "added" && updateB.type === "deleted") {
        // These two completely cancel each other out.
        return undefined;
    }
    if (updateA.type === "deleted" && updateB.type === "added") {
        const added = [];
        const deleted = [];
        const deletedModules = new Set(updateA.modules ?? []);
        const addedModules = new Set(updateB.modules ?? []);
        for (const moduleId of addedModules){
            if (!deletedModules.has(moduleId)) {
                added.push(moduleId);
            }
        }
        for (const moduleId of deletedModules){
            if (!addedModules.has(moduleId)) {
                deleted.push(moduleId);
            }
        }
        if (added.length === 0 && deleted.length === 0) {
            return undefined;
        }
        return {
            type: "partial",
            added,
            deleted
        };
    }
    if (updateA.type === "partial" && updateB.type === "partial") {
        const added = new Set([
            ...updateA.added ?? [],
            ...updateB.added ?? []
        ]);
        const deleted = new Set([
            ...updateA.deleted ?? [],
            ...updateB.deleted ?? []
        ]);
        if (updateB.added != null) {
            for (const moduleId of updateB.added){
                deleted.delete(moduleId);
            }
        }
        if (updateB.deleted != null) {
            for (const moduleId of updateB.deleted){
                added.delete(moduleId);
            }
        }
        return {
            type: "partial",
            added: [
                ...added
            ],
            deleted: [
                ...deleted
            ]
        };
    }
    if (updateA.type === "added" && updateB.type === "partial") {
        const modules = new Set([
            ...updateA.modules ?? [],
            ...updateB.added ?? []
        ]);
        for (const moduleId of updateB.deleted ?? []){
            modules.delete(moduleId);
        }
        return {
            type: "added",
            modules: [
                ...modules
            ]
        };
    }
    if (updateA.type === "partial" && updateB.type === "deleted") {
        // We could eagerly return `updateB` here, but this would potentially be
        // incorrect if `updateA` has added modules.
        const modules = new Set(updateB.modules ?? []);
        if (updateA.added != null) {
            for (const moduleId of updateA.added){
                modules.delete(moduleId);
            }
        }
        return {
            type: "deleted",
            modules: [
                ...modules
            ]
        };
    }
    // Any other update combination is invalid.
    return undefined;
}
function invariant(_, message) {
    throw new Error(`Invariant: ${message}`);
}
const CRITICAL = [
    "bug",
    "error",
    "fatal"
];
function compareByList(list, a, b) {
    const aI = list.indexOf(a) + 1 || list.length;
    const bI = list.indexOf(b) + 1 || list.length;
    return aI - bI;
}
const chunksWithIssues = new Map();
function emitIssues() {
    const issues = [];
    const deduplicationSet = new Set();
    for (const [_, chunkIssues] of chunksWithIssues){
        for (const chunkIssue of chunkIssues){
            if (deduplicationSet.has(chunkIssue.formatted)) continue;
            issues.push(chunkIssue);
            deduplicationSet.add(chunkIssue.formatted);
        }
    }
    sortIssues(issues);
    hooks.issues(issues);
}
function handleIssues(msg) {
    const key = resourceKey(msg.resource);
    let hasCriticalIssues = false;
    for (const issue of msg.issues){
        if (CRITICAL.includes(issue.severity)) {
            hasCriticalIssues = true;
        }
    }
    if (msg.issues.length > 0) {
        chunksWithIssues.set(key, msg.issues);
    } else if (chunksWithIssues.has(key)) {
        chunksWithIssues.delete(key);
    }
    emitIssues();
    return hasCriticalIssues;
}
const SEVERITY_ORDER = [
    "bug",
    "fatal",
    "error",
    "warning",
    "info",
    "log"
];
const CATEGORY_ORDER = [
    "parse",
    "resolve",
    "code generation",
    "rendering",
    "typescript",
    "other"
];
function sortIssues(issues) {
    issues.sort((a, b)=>{
        const first = compareByList(SEVERITY_ORDER, a.severity, b.severity);
        if (first !== 0) return first;
        return compareByList(CATEGORY_ORDER, a.category, b.category);
    });
}
const hooks = {
    beforeRefresh: ()=>{},
    refresh: ()=>{},
    buildOk: ()=>{},
    issues: (_issues)=>{}
};
function setHooks(newHooks) {
    Object.assign(hooks, newHooks);
}
function handleSocketMessage(msg) {
    sortIssues(msg.issues);
    handleIssues(msg);
    switch(msg.type){
        case "issues":
            break;
        case "partial":
            // aggregate updates
            aggregateUpdates(msg);
            break;
        default:
            // run single update
            const runHooks = chunkListsWithPendingUpdates.size === 0;
            if (runHooks) hooks.beforeRefresh();
            triggerUpdate(msg);
            if (runHooks) finalizeUpdate();
            break;
    }
}
function finalizeUpdate() {
    hooks.refresh();
    hooks.buildOk();
    // This is used by the Next.js integration test suite to notify it when HMR
    // updates have been completed.
    // TODO: Only run this in test environments (gate by `process.env.__NEXT_TEST_MODE`)
    if (globalThis.__NEXT_HMR_CB) {
        globalThis.__NEXT_HMR_CB();
        globalThis.__NEXT_HMR_CB = null;
    }
}
function subscribeToChunkUpdate(chunkListPath, sendMessage, callback) {
    return subscribeToUpdate({
        path: chunkListPath
    }, sendMessage, callback);
}
function subscribeToUpdate(resource, sendMessage, callback) {
    const key = resourceKey(resource);
    let callbackSet;
    const existingCallbackSet = updateCallbackSets.get(key);
    if (!existingCallbackSet) {
        callbackSet = {
            callbacks: new Set([
                callback
            ]),
            unsubscribe: subscribeToUpdates(sendMessage, resource)
        };
        updateCallbackSets.set(key, callbackSet);
    } else {
        existingCallbackSet.callbacks.add(callback);
        callbackSet = existingCallbackSet;
    }
    return ()=>{
        callbackSet.callbacks.delete(callback);
        if (callbackSet.callbacks.size === 0) {
            callbackSet.unsubscribe();
            updateCallbackSets.delete(key);
        }
    };
}
function triggerUpdate(msg) {
    const key = resourceKey(msg.resource);
    const callbackSet = updateCallbackSets.get(key);
    if (!callbackSet) {
        return;
    }
    for (const callback of callbackSet.callbacks){
        callback(msg);
    }
    if (msg.type === "notFound") {
        // This indicates that the resource which we subscribed to either does not exist or
        // has been deleted. In either case, we should clear all update callbacks, so if a
        // new subscription is created for the same resource, it will send a new "subscribe"
        // message to the server.
        // No need to send an "unsubscribe" message to the server, it will have already
        // dropped the update stream before sending the "notFound" message.
        updateCallbackSets.delete(key);
    }
}
}}),
"[project]/next-i18next.config.js [client] (ecmascript)": (function(__turbopack_context__) {

var { g: global, __dirname, k: __turbopack_refresh__, m: module, e: exports } = __turbopack_context__;
{
/** @type {import('next-i18next').UserConfig} */ var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$polyfills$2f$process$2e$js__$5b$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/build/polyfills/process.js [client] (ecmascript)");
module.exports = {
    debug: ("TURBOPACK compile-time value", "development") === "development",
    i18n: {
        defaultLocale: "pt-BR",
        locales: [
            "en",
            "pt-BR"
        ]
    },
    react: {
        bindI18n: "loaded languageChanged",
        bindI18nStore: "added",
        useSuspense: true
    }
};
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(module, globalThis.$RefreshHelpers$);
}
}}),
"[project]/amplify_outputs.json (json)": ((__turbopack_context__) => {

var { g: global, __dirname } = __turbopack_context__;
{
__turbopack_context__.v(JSON.parse("{\"auth\":{\"user_pool_id\":\"us-east-1_M0sbMqIyB\",\"aws_region\":\"us-east-1\",\"user_pool_client_id\":\"37oshechg4sdk4h0kdrb53joha\",\"identity_pool_id\":\"us-east-1:b5ef04c4-62bb-44b6-a462-28b56f7c1e44\",\"mfa_methods\":[],\"standard_required_attributes\":[\"email\"],\"username_attributes\":[\"email\"],\"user_verification_types\":[\"email\"],\"groups\":[],\"mfa_configuration\":\"NONE\",\"password_policy\":{\"min_length\":8,\"require_lowercase\":true,\"require_numbers\":true,\"require_symbols\":true,\"require_uppercase\":true},\"unauthenticated_identities_enabled\":true},\"data\":{\"url\":\"https://v66u2qvcqva7xkuazcyex6egny.appsync-api.us-east-1.amazonaws.com/graphql\",\"aws_region\":\"us-east-1\",\"default_authorization_type\":\"AWS_IAM\",\"authorization_types\":[\"AMAZON_COGNITO_USER_POOLS\"],\"model_introspection\":{\"version\":1,\"models\":{\"weddingRSVP\":{\"name\":\"weddingRSVP\",\"fields\":{\"id\":{\"name\":\"id\",\"isArray\":false,\"type\":\"ID\",\"isRequired\":true,\"attributes\":[]},\"name\":{\"name\":\"name\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"language\":{\"name\":\"language\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"email\":{\"name\":\"email\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"phone\":{\"name\":\"phone\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"phoneOptIn\":{\"name\":\"phoneOptIn\",\"isArray\":false,\"type\":\"Boolean\",\"isRequired\":false,\"attributes\":[]},\"isBringingPlusOne\":{\"name\":\"isBringingPlusOne\",\"isArray\":false,\"type\":\"Boolean\",\"isRequired\":false,\"attributes\":[]},\"plusOneName\":{\"name\":\"plusOneName\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"foodRestrictions\":{\"name\":\"foodRestrictions\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"message\":{\"name\":\"message\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"createdAt\":{\"name\":\"createdAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true},\"updatedAt\":{\"name\":\"updatedAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true}},\"syncable\":true,\"pluralName\":\"weddingRSVPS\",\"attributes\":[{\"type\":\"model\",\"properties\":{}},{\"type\":\"auth\",\"properties\":{\"rules\":[{\"allow\":\"public\",\"provider\":\"iam\",\"operations\":[\"create\",\"list\"]}]}}],\"primaryKeyInfo\":{\"isCustomPrimaryKey\":false,\"primaryKeyFieldName\":\"id\",\"sortKeyFieldNames\":[]}},\"messages\":{\"name\":\"messages\",\"fields\":{\"id\":{\"name\":\"id\",\"isArray\":false,\"type\":\"ID\",\"isRequired\":true,\"attributes\":[]},\"sender\":{\"name\":\"sender\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"message\":{\"name\":\"message\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"createdAt\":{\"name\":\"createdAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true},\"updatedAt\":{\"name\":\"updatedAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true}},\"syncable\":true,\"pluralName\":\"messages\",\"attributes\":[{\"type\":\"model\",\"properties\":{}},{\"type\":\"auth\",\"properties\":{\"rules\":[{\"allow\":\"public\",\"provider\":\"iam\",\"operations\":[\"create\"]}]}}],\"primaryKeyInfo\":{\"isCustomPrimaryKey\":false,\"primaryKeyFieldName\":\"id\",\"sortKeyFieldNames\":[]}},\"hotelSuggestions\":{\"name\":\"hotelSuggestions\",\"fields\":{\"id\":{\"name\":\"id\",\"isArray\":false,\"type\":\"ID\",\"isRequired\":true,\"attributes\":[]},\"name\":{\"name\":\"name\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"slug\":{\"name\":\"slug\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"address\":{\"name\":\"address\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"image\":{\"name\":\"image\",\"isArray\":false,\"type\":\"AWSURL\",\"isRequired\":false,\"attributes\":[]},\"website\":{\"name\":\"website\",\"isArray\":false,\"type\":\"AWSURL\",\"isRequired\":false,\"attributes\":[]},\"phone\":{\"name\":\"phone\",\"isArray\":false,\"type\":\"AWSPhone\",\"isRequired\":false,\"attributes\":[]},\"instagramHandle\":{\"name\":\"instagramHandle\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"whatsappPhone\":{\"name\":\"whatsappPhone\",\"isArray\":false,\"type\":\"AWSPhone\",\"isRequired\":false,\"attributes\":[]},\"location\":{\"name\":\"location\",\"isArray\":false,\"type\":{\"nonModel\":\"HotelSuggestionsLocation\"},\"isRequired\":false,\"attributes\":[]},\"order\":{\"name\":\"order\",\"isArray\":false,\"type\":\"Int\",\"isRequired\":false,\"attributes\":[]},\"createdAt\":{\"name\":\"createdAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true},\"updatedAt\":{\"name\":\"updatedAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true}},\"syncable\":true,\"pluralName\":\"hotelSuggestions\",\"attributes\":[{\"type\":\"model\",\"properties\":{}},{\"type\":\"key\",\"properties\":{\"name\":\"hotelSuggestionsBySlug\",\"queryField\":\"listHotelSuggestionsBySlug\",\"fields\":[\"slug\"]}},{\"type\":\"auth\",\"properties\":{\"rules\":[{\"allow\":\"public\",\"provider\":\"iam\",\"operations\":[\"read\"]}]}}],\"primaryKeyInfo\":{\"isCustomPrimaryKey\":false,\"primaryKeyFieldName\":\"id\",\"sortKeyFieldNames\":[]}},\"foodSuggestions\":{\"name\":\"foodSuggestions\",\"fields\":{\"id\":{\"name\":\"id\",\"isArray\":false,\"type\":\"ID\",\"isRequired\":true,\"attributes\":[]},\"name\":{\"name\":\"name\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"slug\":{\"name\":\"slug\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"address\":{\"name\":\"address\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"description\":{\"name\":\"description\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"descriptionPtBr\":{\"name\":\"descriptionPtBr\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"image\":{\"name\":\"image\",\"isArray\":false,\"type\":\"AWSURL\",\"isRequired\":false,\"attributes\":[]},\"website\":{\"name\":\"website\",\"isArray\":false,\"type\":\"AWSURL\",\"isRequired\":false,\"attributes\":[]},\"foodType\":{\"name\":\"foodType\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"instagramHandle\":{\"name\":\"instagramHandle\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"whatsappPhone\":{\"name\":\"whatsappPhone\",\"isArray\":false,\"type\":\"AWSPhone\",\"isRequired\":false,\"attributes\":[]},\"location\":{\"name\":\"location\",\"isArray\":false,\"type\":{\"nonModel\":\"FoodSuggestionsLocation\"},\"isRequired\":false,\"attributes\":[]},\"order\":{\"name\":\"order\",\"isArray\":false,\"type\":\"Int\",\"isRequired\":false,\"attributes\":[]},\"createdAt\":{\"name\":\"createdAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true},\"updatedAt\":{\"name\":\"updatedAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true}},\"syncable\":true,\"pluralName\":\"foodSuggestions\",\"attributes\":[{\"type\":\"model\",\"properties\":{}},{\"type\":\"key\",\"properties\":{\"name\":\"foodSuggestionsBySlug\",\"queryField\":\"listFoodSuggestionsBySlug\",\"fields\":[\"slug\"]}},{\"type\":\"auth\",\"properties\":{\"rules\":[{\"allow\":\"public\",\"provider\":\"iam\",\"operations\":[\"read\"]}]}}],\"primaryKeyInfo\":{\"isCustomPrimaryKey\":false,\"primaryKeyFieldName\":\"id\",\"sortKeyFieldNames\":[]}},\"beautySuggestions\":{\"name\":\"beautySuggestions\",\"fields\":{\"id\":{\"name\":\"id\",\"isArray\":false,\"type\":\"ID\",\"isRequired\":true,\"attributes\":[]},\"name\":{\"name\":\"name\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"slug\":{\"name\":\"slug\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"address\":{\"name\":\"address\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"image\":{\"name\":\"image\",\"isArray\":false,\"type\":\"AWSURL\",\"isRequired\":false,\"attributes\":[]},\"website\":{\"name\":\"website\",\"isArray\":false,\"type\":\"AWSURL\",\"isRequired\":false,\"attributes\":[]},\"servicesOffered\":{\"name\":\"servicesOffered\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"instagramHandle\":{\"name\":\"instagramHandle\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"whatsappPhone\":{\"name\":\"whatsappPhone\",\"isArray\":false,\"type\":\"AWSPhone\",\"isRequired\":false,\"attributes\":[]},\"location\":{\"name\":\"location\",\"isArray\":false,\"type\":{\"nonModel\":\"BeautySuggestionsLocation\"},\"isRequired\":false,\"attributes\":[]},\"order\":{\"name\":\"order\",\"isArray\":false,\"type\":\"Int\",\"isRequired\":false,\"attributes\":[]},\"createdAt\":{\"name\":\"createdAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true},\"updatedAt\":{\"name\":\"updatedAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true}},\"syncable\":true,\"pluralName\":\"beautySuggestions\",\"attributes\":[{\"type\":\"model\",\"properties\":{}},{\"type\":\"key\",\"properties\":{\"name\":\"beautySuggestionsBySlug\",\"queryField\":\"listBeautySuggestionsBySlug\",\"fields\":[\"slug\"]}},{\"type\":\"auth\",\"properties\":{\"rules\":[{\"allow\":\"public\",\"provider\":\"iam\",\"operations\":[\"read\"]}]}}],\"primaryKeyInfo\":{\"isCustomPrimaryKey\":false,\"primaryKeyFieldName\":\"id\",\"sortKeyFieldNames\":[]}},\"thingsToDoSuggestions\":{\"name\":\"thingsToDoSuggestions\",\"fields\":{\"id\":{\"name\":\"id\",\"isArray\":false,\"type\":\"ID\",\"isRequired\":true,\"attributes\":[]},\"name\":{\"name\":\"name\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"slug\":{\"name\":\"slug\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"description\":{\"name\":\"description\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"descriptionPtBr\":{\"name\":\"descriptionPtBr\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"address\":{\"name\":\"address\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"image\":{\"name\":\"image\",\"isArray\":false,\"type\":\"AWSURL\",\"isRequired\":false,\"attributes\":[]},\"website\":{\"name\":\"website\",\"isArray\":false,\"type\":\"AWSURL\",\"isRequired\":false,\"attributes\":[]},\"instagramHandle\":{\"name\":\"instagramHandle\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"whatsappPhone\":{\"name\":\"whatsappPhone\",\"isArray\":false,\"type\":\"AWSPhone\",\"isRequired\":false,\"attributes\":[]},\"location\":{\"name\":\"location\",\"isArray\":false,\"type\":{\"nonModel\":\"ThingsToDoSuggestionsLocation\"},\"isRequired\":false,\"attributes\":[]},\"order\":{\"name\":\"order\",\"isArray\":false,\"type\":\"Int\",\"isRequired\":false,\"attributes\":[]},\"createdAt\":{\"name\":\"createdAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true},\"updatedAt\":{\"name\":\"updatedAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true}},\"syncable\":true,\"pluralName\":\"thingsToDoSuggestions\",\"attributes\":[{\"type\":\"model\",\"properties\":{}},{\"type\":\"key\",\"properties\":{\"name\":\"thingsToDoSuggestionsBySlug\",\"queryField\":\"listThingsToDoSuggestionsBySlug\",\"fields\":[\"slug\"]}},{\"type\":\"auth\",\"properties\":{\"rules\":[{\"allow\":\"public\",\"provider\":\"iam\",\"operations\":[\"read\"]}]}}],\"primaryKeyInfo\":{\"isCustomPrimaryKey\":false,\"primaryKeyFieldName\":\"id\",\"sortKeyFieldNames\":[]}}},\"enums\":{},\"nonModels\":{\"HotelSuggestionsLocation\":{\"name\":\"HotelSuggestionsLocation\",\"fields\":{\"latitude\":{\"name\":\"latitude\",\"isArray\":false,\"type\":\"Float\",\"isRequired\":true,\"attributes\":[]},\"longitude\":{\"name\":\"longitude\",\"isArray\":false,\"type\":\"Float\",\"isRequired\":true,\"attributes\":[]}}},\"FoodSuggestionsLocation\":{\"name\":\"FoodSuggestionsLocation\",\"fields\":{\"latitude\":{\"name\":\"latitude\",\"isArray\":false,\"type\":\"Float\",\"isRequired\":true,\"attributes\":[]},\"longitude\":{\"name\":\"longitude\",\"isArray\":false,\"type\":\"Float\",\"isRequired\":true,\"attributes\":[]}}},\"BeautySuggestionsLocation\":{\"name\":\"BeautySuggestionsLocation\",\"fields\":{\"latitude\":{\"name\":\"latitude\",\"isArray\":false,\"type\":\"Float\",\"isRequired\":true,\"attributes\":[]},\"longitude\":{\"name\":\"longitude\",\"isArray\":false,\"type\":\"Float\",\"isRequired\":true,\"attributes\":[]}}},\"ThingsToDoSuggestionsLocation\":{\"name\":\"ThingsToDoSuggestionsLocation\",\"fields\":{\"latitude\":{\"name\":\"latitude\",\"isArray\":false,\"type\":\"Float\",\"isRequired\":true,\"attributes\":[]},\"longitude\":{\"name\":\"longitude\",\"isArray\":false,\"type\":\"Float\",\"isRequired\":true,\"attributes\":[]}}}}}},\"storage\":{\"aws_region\":\"us-east-1\",\"bucket_name\":\"amplify-d2qvl0uovmvzg9-ma-cristinegennarobucketf99-qmnbiyveilk4\",\"buckets\":[{\"name\":\"cristinegennaro\",\"bucket_name\":\"amplify-d2qvl0uovmvzg9-ma-cristinegennarobucketf99-qmnbiyveilk4\",\"aws_region\":\"us-east-1\",\"paths\":{\"contracts/*\":{\"authenticated\":[\"get\",\"list\",\"write\",\"delete\"]},\"pictures/*\":{\"guest\":[\"get\",\"list\"]}}}]},\"version\":\"1.3\",\"custom\":{\"topicArn\":\"arn:aws:sns:us-east-1:802060244747:amplify-d2qvl0uovmvzg9-main-branch-0576faafc9-weddingResourcesA82D57EF-IYNA07Y1A0BQ-newRSVPTopic4785B911-ssJI4xuBCPYN\",\"topicName\":\"amplify-d2qvl0uovmvzg9-main-branch-0576faafc9-weddingResourcesA82D57EF-IYNA07Y1A0BQ-newRSVPTopic4785B911-ssJI4xuBCPYN\"}}"));}}),
"[project]/pages/_app.tsx [client] (ecmascript)": ((__turbopack_context__) => {
"use strict";

var { g: global, __dirname, k: __turbopack_refresh__, m: module } = __turbopack_context__;
{
__turbopack_context__.s({
    "default": (()=>__TURBOPACK__default__export__)
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/react/jsx-dev-runtime.js [client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$heroui$2f$system$2f$dist$2f$chunk$2d$OKNU54ZL$2e$mjs__$5b$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@heroui/system/dist/chunk-OKNU54ZL.mjs [client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$themes$2f$dist$2f$index$2e$module$2e$js__$5b$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next-themes/dist/index.module.js [client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$router$2e$js__$5b$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/router.js [client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$i18next$2f$dist$2f$esm$2f$index$2e$js__$5b$client$5d$__$28$ecmascript$29$__$3c$module__evaluation$3e$__ = __turbopack_context__.i("[project]/node_modules/next-i18next/dist/esm/index.js [client] (ecmascript) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$i18next$2f$dist$2f$esm$2f$appWithTranslation$2e$js__$5b$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/node_modules/next-i18next/dist/esm/appWithTranslation.js [client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$next$2d$i18next$2e$config$2e$js__$5b$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/next-i18next.config.js [client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$aws$2d$amplify$2f$dist$2f$esm$2f$initSingleton$2e$mjs__$5b$client$5d$__$28$ecmascript$29$__$3c$export__DefaultAmplify__as__Amplify$3e$__ = __turbopack_context__.i("[project]/node_modules/aws-amplify/dist/esm/initSingleton.mjs [client] (ecmascript) <export DefaultAmplify as Amplify>");
var __TURBOPACK__imported__module__$5b$project$5d2f$amplify_outputs$2e$json__$28$json$29$__ = __turbopack_context__.i("[project]/amplify_outputs.json (json)");
;
var _s = __turbopack_context__.k.signature();
;
;
;
;
;
;
;
;
__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$aws$2d$amplify$2f$dist$2f$esm$2f$initSingleton$2e$mjs__$5b$client$5d$__$28$ecmascript$29$__$3c$export__DefaultAmplify__as__Amplify$3e$__["Amplify"].configure(__TURBOPACK__imported__module__$5b$project$5d2f$amplify_outputs$2e$json__$28$json$29$__["default"]);
function App({ Component, pageProps }) {
    _s();
    const router = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$router$2e$js__$5b$client$5d$__$28$ecmascript$29$__["useRouter"])();
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$themes$2f$dist$2f$index$2e$module$2e$js__$5b$client$5d$__$28$ecmascript$29$__["ThemeProvider"], {
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$heroui$2f$system$2f$dist$2f$chunk$2d$OKNU54ZL$2e$mjs__$5b$client$5d$__$28$ecmascript$29$__["HeroUIProvider"], {
                navigate: router.push,
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Component, {
                    ...pageProps
                }, void 0, false, {
                    fileName: "[project]/pages/_app.tsx",
                    lineNumber: 26,
                    columnNumber: 11
                }, this)
            }, void 0, false, {
                fileName: "[project]/pages/_app.tsx",
                lineNumber: 25,
                columnNumber: 9
            }, this)
        }, void 0, false, {
            fileName: "[project]/pages/_app.tsx",
            lineNumber: 24,
            columnNumber: 7
        }, this)
    }, void 0, false, {
        fileName: "[project]/pages/_app.tsx",
        lineNumber: 23,
        columnNumber: 5
    }, this);
}
_s(App, "fN7XvhJ+p5oE6+Xlo0NJmXpxjC8=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$router$2e$js__$5b$client$5d$__$28$ecmascript$29$__["useRouter"]
    ];
});
_c = App;
const __TURBOPACK__default__export__ = _c1 = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$i18next$2f$dist$2f$esm$2f$appWithTranslation$2e$js__$5b$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["appWithTranslation"])(App, __TURBOPACK__imported__module__$5b$project$5d2f$next$2d$i18next$2e$config$2e$js__$5b$client$5d$__$28$ecmascript$29$__["default"]);
var _c, _c1;
__turbopack_context__.k.register(_c, "App");
__turbopack_context__.k.register(_c1, "%default%");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(module, globalThis.$RefreshHelpers$);
}
}}),
"[next]/entry/page-loader.ts { PAGE => \"[project]/pages/_app.tsx [client] (ecmascript)\" } [client] (ecmascript)": (function(__turbopack_context__) {

var { g: global, __dirname, m: module, e: exports } = __turbopack_context__;
{
const PAGE_PATH = "/_app";
(window.__NEXT_P = window.__NEXT_P || []).push([
    PAGE_PATH,
    ()=>{
        return __turbopack_context__.r("[project]/pages/_app.tsx [client] (ecmascript)");
    }
]);
// @ts-expect-error module.hot exists
if (module.hot) {
    // @ts-expect-error module.hot exists
    module.hot.dispose(function() {
        window.__NEXT_P.push([
            PAGE_PATH
        ]);
    });
}
}}),
"[project]/pages/_app (hmr-entry)": ((__turbopack_context__) => {
"use strict";

var { g: global, __dirname, m: module } = __turbopack_context__;
{
__turbopack_context__.r("[next]/entry/page-loader.ts { PAGE => \"[project]/pages/_app.tsx [client] (ecmascript)\" } [client] (ecmascript)");
}}),
}]);

//# sourceMappingURL=%5Broot-of-the-server%5D__87e6d7d2._.js.map