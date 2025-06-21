module.exports = {

"[externals]/@heroui/system [external] (@heroui/system, esm_import)": ((__turbopack_context__) => {
"use strict";

var { g: global, __dirname, a: __turbopack_async_module__ } = __turbopack_context__;
__turbopack_async_module__(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {
const mod = await __turbopack_context__.y("@heroui/system");

__turbopack_context__.n(mod);
__turbopack_async_result__();
} catch(e) { __turbopack_async_result__(e); } }, true);}),
"[externals]/next-themes [external] (next-themes, cjs)": (function(__turbopack_context__) {

var { g: global, __dirname, m: module, e: exports } = __turbopack_context__;
{
const mod = __turbopack_context__.x("next-themes", () => require("next-themes"));

module.exports = mod;
}}),
"[externals]/fs [external] (fs, cjs)": (function(__turbopack_context__) {

var { g: global, __dirname, m: module, e: exports } = __turbopack_context__;
{
const mod = __turbopack_context__.x("fs", () => require("fs"));

module.exports = mod;
}}),
"[externals]/stream [external] (stream, cjs)": (function(__turbopack_context__) {

var { g: global, __dirname, m: module, e: exports } = __turbopack_context__;
{
const mod = __turbopack_context__.x("stream", () => require("stream"));

module.exports = mod;
}}),
"[externals]/zlib [external] (zlib, cjs)": (function(__turbopack_context__) {

var { g: global, __dirname, m: module, e: exports } = __turbopack_context__;
{
const mod = __turbopack_context__.x("zlib", () => require("zlib"));

module.exports = mod;
}}),
"[externals]/react-dom [external] (react-dom, cjs)": (function(__turbopack_context__) {

var { g: global, __dirname, m: module, e: exports } = __turbopack_context__;
{
const mod = __turbopack_context__.x("react-dom", () => require("react-dom"));

module.exports = mod;
}}),
"[externals]/next-i18next [external] (next-i18next, cjs)": (function(__turbopack_context__) {

var { g: global, __dirname, m: module, e: exports } = __turbopack_context__;
{
const mod = __turbopack_context__.x("next-i18next", () => require("next-i18next"));

module.exports = mod;
}}),
"[project]/next-i18next.config.js [ssr] (ecmascript)": (function(__turbopack_context__) {

var { g: global, __dirname, m: module, e: exports } = __turbopack_context__;
{
/** @type {import('next-i18next').UserConfig} */ module.exports = {
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
}}),
"[externals]/aws-amplify [external] (aws-amplify, esm_import)": ((__turbopack_context__) => {
"use strict";

var { g: global, __dirname, a: __turbopack_async_module__ } = __turbopack_context__;
__turbopack_async_module__(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {
const mod = await __turbopack_context__.y("aws-amplify");

__turbopack_context__.n(mod);
__turbopack_async_result__();
} catch(e) { __turbopack_async_result__(e); } }, true);}),
"[project]/amplify_outputs.json (json)": ((__turbopack_context__) => {

var { g: global, __dirname } = __turbopack_context__;
{
__turbopack_context__.v(JSON.parse("{\"auth\":{\"user_pool_id\":\"us-east-1_M0sbMqIyB\",\"aws_region\":\"us-east-1\",\"user_pool_client_id\":\"37oshechg4sdk4h0kdrb53joha\",\"identity_pool_id\":\"us-east-1:b5ef04c4-62bb-44b6-a462-28b56f7c1e44\",\"mfa_methods\":[],\"standard_required_attributes\":[\"email\"],\"username_attributes\":[\"email\"],\"user_verification_types\":[\"email\"],\"groups\":[],\"mfa_configuration\":\"NONE\",\"password_policy\":{\"min_length\":8,\"require_lowercase\":true,\"require_numbers\":true,\"require_symbols\":true,\"require_uppercase\":true},\"unauthenticated_identities_enabled\":true},\"data\":{\"url\":\"https://v66u2qvcqva7xkuazcyex6egny.appsync-api.us-east-1.amazonaws.com/graphql\",\"aws_region\":\"us-east-1\",\"default_authorization_type\":\"AWS_IAM\",\"authorization_types\":[\"AMAZON_COGNITO_USER_POOLS\"],\"model_introspection\":{\"version\":1,\"models\":{\"weddingRSVP\":{\"name\":\"weddingRSVP\",\"fields\":{\"id\":{\"name\":\"id\",\"isArray\":false,\"type\":\"ID\",\"isRequired\":true,\"attributes\":[]},\"name\":{\"name\":\"name\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"language\":{\"name\":\"language\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"email\":{\"name\":\"email\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"phone\":{\"name\":\"phone\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"phoneOptIn\":{\"name\":\"phoneOptIn\",\"isArray\":false,\"type\":\"Boolean\",\"isRequired\":false,\"attributes\":[]},\"isBringingPlusOne\":{\"name\":\"isBringingPlusOne\",\"isArray\":false,\"type\":\"Boolean\",\"isRequired\":false,\"attributes\":[]},\"plusOneName\":{\"name\":\"plusOneName\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"foodRestrictions\":{\"name\":\"foodRestrictions\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"message\":{\"name\":\"message\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"createdAt\":{\"name\":\"createdAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true},\"updatedAt\":{\"name\":\"updatedAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true}},\"syncable\":true,\"pluralName\":\"weddingRSVPS\",\"attributes\":[{\"type\":\"model\",\"properties\":{}},{\"type\":\"auth\",\"properties\":{\"rules\":[{\"allow\":\"public\",\"provider\":\"iam\",\"operations\":[\"create\",\"list\"]}]}}],\"primaryKeyInfo\":{\"isCustomPrimaryKey\":false,\"primaryKeyFieldName\":\"id\",\"sortKeyFieldNames\":[]}},\"messages\":{\"name\":\"messages\",\"fields\":{\"id\":{\"name\":\"id\",\"isArray\":false,\"type\":\"ID\",\"isRequired\":true,\"attributes\":[]},\"sender\":{\"name\":\"sender\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"message\":{\"name\":\"message\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"createdAt\":{\"name\":\"createdAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true},\"updatedAt\":{\"name\":\"updatedAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true}},\"syncable\":true,\"pluralName\":\"messages\",\"attributes\":[{\"type\":\"model\",\"properties\":{}},{\"type\":\"auth\",\"properties\":{\"rules\":[{\"allow\":\"public\",\"provider\":\"iam\",\"operations\":[\"create\"]}]}}],\"primaryKeyInfo\":{\"isCustomPrimaryKey\":false,\"primaryKeyFieldName\":\"id\",\"sortKeyFieldNames\":[]}},\"hotelSuggestions\":{\"name\":\"hotelSuggestions\",\"fields\":{\"id\":{\"name\":\"id\",\"isArray\":false,\"type\":\"ID\",\"isRequired\":true,\"attributes\":[]},\"name\":{\"name\":\"name\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"slug\":{\"name\":\"slug\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"address\":{\"name\":\"address\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"image\":{\"name\":\"image\",\"isArray\":false,\"type\":\"AWSURL\",\"isRequired\":false,\"attributes\":[]},\"website\":{\"name\":\"website\",\"isArray\":false,\"type\":\"AWSURL\",\"isRequired\":false,\"attributes\":[]},\"phone\":{\"name\":\"phone\",\"isArray\":false,\"type\":\"AWSPhone\",\"isRequired\":false,\"attributes\":[]},\"instagramHandle\":{\"name\":\"instagramHandle\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"whatsappPhone\":{\"name\":\"whatsappPhone\",\"isArray\":false,\"type\":\"AWSPhone\",\"isRequired\":false,\"attributes\":[]},\"location\":{\"name\":\"location\",\"isArray\":false,\"type\":{\"nonModel\":\"HotelSuggestionsLocation\"},\"isRequired\":false,\"attributes\":[]},\"order\":{\"name\":\"order\",\"isArray\":false,\"type\":\"Int\",\"isRequired\":false,\"attributes\":[]},\"createdAt\":{\"name\":\"createdAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true},\"updatedAt\":{\"name\":\"updatedAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true}},\"syncable\":true,\"pluralName\":\"hotelSuggestions\",\"attributes\":[{\"type\":\"model\",\"properties\":{}},{\"type\":\"key\",\"properties\":{\"name\":\"hotelSuggestionsBySlug\",\"queryField\":\"listHotelSuggestionsBySlug\",\"fields\":[\"slug\"]}},{\"type\":\"auth\",\"properties\":{\"rules\":[{\"allow\":\"public\",\"provider\":\"iam\",\"operations\":[\"read\"]}]}}],\"primaryKeyInfo\":{\"isCustomPrimaryKey\":false,\"primaryKeyFieldName\":\"id\",\"sortKeyFieldNames\":[]}},\"foodSuggestions\":{\"name\":\"foodSuggestions\",\"fields\":{\"id\":{\"name\":\"id\",\"isArray\":false,\"type\":\"ID\",\"isRequired\":true,\"attributes\":[]},\"name\":{\"name\":\"name\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"slug\":{\"name\":\"slug\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"address\":{\"name\":\"address\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"description\":{\"name\":\"description\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"descriptionPtBr\":{\"name\":\"descriptionPtBr\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"image\":{\"name\":\"image\",\"isArray\":false,\"type\":\"AWSURL\",\"isRequired\":false,\"attributes\":[]},\"website\":{\"name\":\"website\",\"isArray\":false,\"type\":\"AWSURL\",\"isRequired\":false,\"attributes\":[]},\"foodType\":{\"name\":\"foodType\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"instagramHandle\":{\"name\":\"instagramHandle\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"whatsappPhone\":{\"name\":\"whatsappPhone\",\"isArray\":false,\"type\":\"AWSPhone\",\"isRequired\":false,\"attributes\":[]},\"location\":{\"name\":\"location\",\"isArray\":false,\"type\":{\"nonModel\":\"FoodSuggestionsLocation\"},\"isRequired\":false,\"attributes\":[]},\"order\":{\"name\":\"order\",\"isArray\":false,\"type\":\"Int\",\"isRequired\":false,\"attributes\":[]},\"createdAt\":{\"name\":\"createdAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true},\"updatedAt\":{\"name\":\"updatedAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true}},\"syncable\":true,\"pluralName\":\"foodSuggestions\",\"attributes\":[{\"type\":\"model\",\"properties\":{}},{\"type\":\"key\",\"properties\":{\"name\":\"foodSuggestionsBySlug\",\"queryField\":\"listFoodSuggestionsBySlug\",\"fields\":[\"slug\"]}},{\"type\":\"auth\",\"properties\":{\"rules\":[{\"allow\":\"public\",\"provider\":\"iam\",\"operations\":[\"read\"]}]}}],\"primaryKeyInfo\":{\"isCustomPrimaryKey\":false,\"primaryKeyFieldName\":\"id\",\"sortKeyFieldNames\":[]}},\"beautySuggestions\":{\"name\":\"beautySuggestions\",\"fields\":{\"id\":{\"name\":\"id\",\"isArray\":false,\"type\":\"ID\",\"isRequired\":true,\"attributes\":[]},\"name\":{\"name\":\"name\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"slug\":{\"name\":\"slug\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"address\":{\"name\":\"address\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"image\":{\"name\":\"image\",\"isArray\":false,\"type\":\"AWSURL\",\"isRequired\":false,\"attributes\":[]},\"website\":{\"name\":\"website\",\"isArray\":false,\"type\":\"AWSURL\",\"isRequired\":false,\"attributes\":[]},\"servicesOffered\":{\"name\":\"servicesOffered\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"instagramHandle\":{\"name\":\"instagramHandle\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"whatsappPhone\":{\"name\":\"whatsappPhone\",\"isArray\":false,\"type\":\"AWSPhone\",\"isRequired\":false,\"attributes\":[]},\"location\":{\"name\":\"location\",\"isArray\":false,\"type\":{\"nonModel\":\"BeautySuggestionsLocation\"},\"isRequired\":false,\"attributes\":[]},\"order\":{\"name\":\"order\",\"isArray\":false,\"type\":\"Int\",\"isRequired\":false,\"attributes\":[]},\"createdAt\":{\"name\":\"createdAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true},\"updatedAt\":{\"name\":\"updatedAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true}},\"syncable\":true,\"pluralName\":\"beautySuggestions\",\"attributes\":[{\"type\":\"model\",\"properties\":{}},{\"type\":\"key\",\"properties\":{\"name\":\"beautySuggestionsBySlug\",\"queryField\":\"listBeautySuggestionsBySlug\",\"fields\":[\"slug\"]}},{\"type\":\"auth\",\"properties\":{\"rules\":[{\"allow\":\"public\",\"provider\":\"iam\",\"operations\":[\"read\"]}]}}],\"primaryKeyInfo\":{\"isCustomPrimaryKey\":false,\"primaryKeyFieldName\":\"id\",\"sortKeyFieldNames\":[]}},\"thingsToDoSuggestions\":{\"name\":\"thingsToDoSuggestions\",\"fields\":{\"id\":{\"name\":\"id\",\"isArray\":false,\"type\":\"ID\",\"isRequired\":true,\"attributes\":[]},\"name\":{\"name\":\"name\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"slug\":{\"name\":\"slug\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"description\":{\"name\":\"description\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"descriptionPtBr\":{\"name\":\"descriptionPtBr\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"address\":{\"name\":\"address\",\"isArray\":false,\"type\":\"String\",\"isRequired\":true,\"attributes\":[]},\"image\":{\"name\":\"image\",\"isArray\":false,\"type\":\"AWSURL\",\"isRequired\":false,\"attributes\":[]},\"website\":{\"name\":\"website\",\"isArray\":false,\"type\":\"AWSURL\",\"isRequired\":false,\"attributes\":[]},\"instagramHandle\":{\"name\":\"instagramHandle\",\"isArray\":false,\"type\":\"String\",\"isRequired\":false,\"attributes\":[]},\"whatsappPhone\":{\"name\":\"whatsappPhone\",\"isArray\":false,\"type\":\"AWSPhone\",\"isRequired\":false,\"attributes\":[]},\"location\":{\"name\":\"location\",\"isArray\":false,\"type\":{\"nonModel\":\"ThingsToDoSuggestionsLocation\"},\"isRequired\":false,\"attributes\":[]},\"order\":{\"name\":\"order\",\"isArray\":false,\"type\":\"Int\",\"isRequired\":false,\"attributes\":[]},\"createdAt\":{\"name\":\"createdAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true},\"updatedAt\":{\"name\":\"updatedAt\",\"isArray\":false,\"type\":\"AWSDateTime\",\"isRequired\":false,\"attributes\":[],\"isReadOnly\":true}},\"syncable\":true,\"pluralName\":\"thingsToDoSuggestions\",\"attributes\":[{\"type\":\"model\",\"properties\":{}},{\"type\":\"key\",\"properties\":{\"name\":\"thingsToDoSuggestionsBySlug\",\"queryField\":\"listThingsToDoSuggestionsBySlug\",\"fields\":[\"slug\"]}},{\"type\":\"auth\",\"properties\":{\"rules\":[{\"allow\":\"public\",\"provider\":\"iam\",\"operations\":[\"read\"]}]}}],\"primaryKeyInfo\":{\"isCustomPrimaryKey\":false,\"primaryKeyFieldName\":\"id\",\"sortKeyFieldNames\":[]}}},\"enums\":{},\"nonModels\":{\"HotelSuggestionsLocation\":{\"name\":\"HotelSuggestionsLocation\",\"fields\":{\"latitude\":{\"name\":\"latitude\",\"isArray\":false,\"type\":\"Float\",\"isRequired\":true,\"attributes\":[]},\"longitude\":{\"name\":\"longitude\",\"isArray\":false,\"type\":\"Float\",\"isRequired\":true,\"attributes\":[]}}},\"FoodSuggestionsLocation\":{\"name\":\"FoodSuggestionsLocation\",\"fields\":{\"latitude\":{\"name\":\"latitude\",\"isArray\":false,\"type\":\"Float\",\"isRequired\":true,\"attributes\":[]},\"longitude\":{\"name\":\"longitude\",\"isArray\":false,\"type\":\"Float\",\"isRequired\":true,\"attributes\":[]}}},\"BeautySuggestionsLocation\":{\"name\":\"BeautySuggestionsLocation\",\"fields\":{\"latitude\":{\"name\":\"latitude\",\"isArray\":false,\"type\":\"Float\",\"isRequired\":true,\"attributes\":[]},\"longitude\":{\"name\":\"longitude\",\"isArray\":false,\"type\":\"Float\",\"isRequired\":true,\"attributes\":[]}}},\"ThingsToDoSuggestionsLocation\":{\"name\":\"ThingsToDoSuggestionsLocation\",\"fields\":{\"latitude\":{\"name\":\"latitude\",\"isArray\":false,\"type\":\"Float\",\"isRequired\":true,\"attributes\":[]},\"longitude\":{\"name\":\"longitude\",\"isArray\":false,\"type\":\"Float\",\"isRequired\":true,\"attributes\":[]}}}}}},\"storage\":{\"aws_region\":\"us-east-1\",\"bucket_name\":\"amplify-d2qvl0uovmvzg9-ma-cristinegennarobucketf99-qmnbiyveilk4\",\"buckets\":[{\"name\":\"cristinegennaro\",\"bucket_name\":\"amplify-d2qvl0uovmvzg9-ma-cristinegennarobucketf99-qmnbiyveilk4\",\"aws_region\":\"us-east-1\",\"paths\":{\"contracts/*\":{\"authenticated\":[\"get\",\"list\",\"write\",\"delete\"]},\"pictures/*\":{\"guest\":[\"get\",\"list\"]}}}]},\"version\":\"1.3\",\"custom\":{\"topicArn\":\"arn:aws:sns:us-east-1:802060244747:amplify-d2qvl0uovmvzg9-main-branch-0576faafc9-weddingResourcesA82D57EF-IYNA07Y1A0BQ-newRSVPTopic4785B911-ssJI4xuBCPYN\",\"topicName\":\"amplify-d2qvl0uovmvzg9-main-branch-0576faafc9-weddingResourcesA82D57EF-IYNA07Y1A0BQ-newRSVPTopic4785B911-ssJI4xuBCPYN\"}}"));}}),
"[project]/pages/_app.tsx [ssr] (ecmascript)": ((__turbopack_context__) => {
"use strict";

var { g: global, __dirname, a: __turbopack_async_module__ } = __turbopack_context__;
__turbopack_async_module__(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {
__turbopack_context__.s({
    "default": (()=>__TURBOPACK__default__export__)
});
var __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/react/jsx-dev-runtime [external] (react/jsx-dev-runtime, cjs)");
var __TURBOPACK__imported__module__$5b$externals$5d2f40$heroui$2f$system__$5b$external$5d$__$2840$heroui$2f$system$2c$__esm_import$29$__ = __turbopack_context__.i("[externals]/@heroui/system [external] (@heroui/system, esm_import)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$next$2d$themes__$5b$external$5d$__$28$next$2d$themes$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/next-themes [external] (next-themes, cjs)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$router$2e$js__$5b$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/router.js [ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$next$2d$i18next__$5b$external$5d$__$28$next$2d$i18next$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/next-i18next [external] (next-i18next, cjs)");
var __TURBOPACK__imported__module__$5b$project$5d2f$next$2d$i18next$2e$config$2e$js__$5b$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/next-i18next.config.js [ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$aws$2d$amplify__$5b$external$5d$__$28$aws$2d$amplify$2c$__esm_import$29$__ = __turbopack_context__.i("[externals]/aws-amplify [external] (aws-amplify, esm_import)");
var __TURBOPACK__imported__module__$5b$project$5d2f$amplify_outputs$2e$json__$28$json$29$__ = __turbopack_context__.i("[project]/amplify_outputs.json (json)");
var __turbopack_async_dependencies__ = __turbopack_handle_async_dependencies__([
    __TURBOPACK__imported__module__$5b$externals$5d2f40$heroui$2f$system__$5b$external$5d$__$2840$heroui$2f$system$2c$__esm_import$29$__,
    __TURBOPACK__imported__module__$5b$externals$5d2f$aws$2d$amplify__$5b$external$5d$__$28$aws$2d$amplify$2c$__esm_import$29$__
]);
([__TURBOPACK__imported__module__$5b$externals$5d2f40$heroui$2f$system__$5b$external$5d$__$2840$heroui$2f$system$2c$__esm_import$29$__, __TURBOPACK__imported__module__$5b$externals$5d2f$aws$2d$amplify__$5b$external$5d$__$28$aws$2d$amplify$2c$__esm_import$29$__] = __turbopack_async_dependencies__.then ? (await __turbopack_async_dependencies__)() : __turbopack_async_dependencies__);
;
;
;
;
;
;
;
;
;
__TURBOPACK__imported__module__$5b$externals$5d2f$aws$2d$amplify__$5b$external$5d$__$28$aws$2d$amplify$2c$__esm_import$29$__["Amplify"].configure(__TURBOPACK__imported__module__$5b$project$5d2f$amplify_outputs$2e$json__$28$json$29$__["default"]);
function App({ Component, pageProps }) {
    const router = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$router$2e$js__$5b$ssr$5d$__$28$ecmascript$29$__["useRouter"])();
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$externals$5d2f$next$2d$themes__$5b$external$5d$__$28$next$2d$themes$2c$__cjs$29$__["ThemeProvider"], {
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])("div", {
            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$externals$5d2f40$heroui$2f$system__$5b$external$5d$__$2840$heroui$2f$system$2c$__esm_import$29$__["HeroUIProvider"], {
                navigate: router.push,
                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])(Component, {
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
const __TURBOPACK__default__export__ = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$next$2d$i18next__$5b$external$5d$__$28$next$2d$i18next$2c$__cjs$29$__["appWithTranslation"])(App, __TURBOPACK__imported__module__$5b$project$5d2f$next$2d$i18next$2e$config$2e$js__$5b$ssr$5d$__$28$ecmascript$29$__["default"]);
__turbopack_async_result__();
} catch(e) { __turbopack_async_result__(e); } }, false);}),

};

//# sourceMappingURL=%5Broot-of-the-server%5D__1ab7e852._.js.map