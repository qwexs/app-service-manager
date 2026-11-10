import { describe, expect, test } from 'bun:test'
import { parseUpdateConfig } from '../../service-manager/src/update/config'
import { getS3Config } from '../src/publish'

const requiredEnv = {
  UPDATE_S3_ENDPOINT: 'https://storage.example.com',
  UPDATE_S3_BUCKET: 'releases',
  UPDATE_S3_ACCESS_KEY_ID: 'fixture-key',
  UPDATE_S3_SECRET_ACCESS_KEY: 'fixture-secret',
  UPDATE_CHANNEL: 'stable',
  UPDATE_CHECK_INTERVAL: '0',
}

for (const [name, readConfig] of [
  ['manager', () => parseUpdateConfig().s3],
  ['publisher', getS3Config],
] as const) {
  describe(`${name}: S3 region`, () => {
    test('использует общий default и сохраняет явно заданный регион', () => {
      const keys = [...Object.keys(requiredEnv), 'UPDATE_S3_REGION']
      const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
      try {
        Object.assign(process.env, requiredEnv)
        for (const region of [undefined, '', 'eu-west-1']) {
          if (region === undefined) delete process.env.UPDATE_S3_REGION
          else process.env.UPDATE_S3_REGION = region
          expect(readConfig()).toEqual({
            endpoint: requiredEnv.UPDATE_S3_ENDPOINT,
            bucket: requiredEnv.UPDATE_S3_BUCKET,
            accessKeyId: requiredEnv.UPDATE_S3_ACCESS_KEY_ID,
            secretAccessKey: requiredEnv.UPDATE_S3_SECRET_ACCESS_KEY,
            region: region || 'us-east-1',
          })
        }
      } finally {
        for (const key of keys) {
          if (saved[key] === undefined) delete process.env[key]
          else process.env[key] = saved[key]
        }
      }
    })
  })
}
