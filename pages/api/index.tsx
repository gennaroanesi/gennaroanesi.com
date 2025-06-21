import type { NextApiRequest, NextApiResponse } from "next";

"use client"
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";



export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse
  ) {
    return res.status(200).json({message: "Hello World!"});
  }
