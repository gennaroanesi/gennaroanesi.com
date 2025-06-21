/*import { type ClientSchema, a, defineData } from "@aws-amplify/backend";

const schema = a.schema({
  weddingRSVP: a
    .model({
      name: a.string().required(),
      language: a.string(),
      email: a.string(),
      phone: a.string(),
      phoneOptIn: a.boolean(),
      isBringingPlusOne: a.boolean(),
      plusOneName: a.string(),
      foodRestrictions: a.string(),
      message: a.string(),
    })
    .authorization((allow) => [allow.guest().to(["create", "list"])]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "iam",
  },
});
*/
