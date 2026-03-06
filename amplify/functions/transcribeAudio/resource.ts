// transcribeAudio is a Python container Lambda — it cannot use defineFunction
// (Node.js only). The function is created as a raw CDK DockerImageFunction
// directly in backend.ts. This file is intentionally empty of exports.
// See: amplify/backend.ts → "transcribeAudio infrastructure" section.
