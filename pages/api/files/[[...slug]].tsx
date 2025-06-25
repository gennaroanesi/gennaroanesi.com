import type { NextApiRequest, NextApiResponse } from 'next'
import { list, getUrl } from 'aws-amplify/storage';

 
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { slug } = req.query;

  const result = await list({
    path: 'public/',
    options: {
        bucket: "gennaroanesi.com",
    }
    // Alternatively, path: ({identityId}) => `album/${identityId}/photos/`
    });

    const linkToStorageFile = await getUrl({        
        path: "public/dolce.jpg",
        options: {
            bucket: "gennaroanesi.com",
        }
        // Alternatively, path: ({identityId}) => `album/${identityId}/1.jpg`
      });
      console.log('signed URL: ', linkToStorageFile.url);
      console.log('URL expires at: ', linkToStorageFile.expiresAt);

  return res.status(200).json({ slug: slug, url: linkToStorageFile.url });
}