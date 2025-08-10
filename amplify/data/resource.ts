import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { statusEnum } from "./enum";



const schema = a
  .schema({
    day: a
      .model({
        date: a.date().required(),
        status: a.enum(Object.keys(statusEnum)),
        notes: a.string(),
        location: a.customType({
            latitude: a.float(),
            longitude: a.float(),
            city: a.string(),
            country: a.string(),
        }),
        ptoFraction: a.float().default(0),
        allDay: a.boolean(),
      })
      .identifier(['date'])
      .authorization((allow) => [allow.group("admins")]),
    event: a
      .model({
        title: a.string().required(),
        startAt: a.datetime().required(),
        endAt: a.datetime(),
        allDay: a.boolean(),
      })
      .authorization((allow) => [allow.group("admins")])
    })


export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
  },
});
