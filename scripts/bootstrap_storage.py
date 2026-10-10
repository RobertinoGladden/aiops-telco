"""Idempotently prepare all buckets, with bounded readiness retries."""
import time
from botocore.exceptions import ClientError
from consumer.kafka_to_minio import create_minio_client
from aiops.config import settings


def main():
    client = create_minio_client()
    for attempt in range(30):
        try:
            client.list_buckets()
            break
        except Exception:
            if attempt == 29:
                raise
            time.sleep(2)
    for bucket in (settings.raw_bucket, settings.processed_bucket, settings.models_bucket):
        try:
            client.head_bucket(Bucket=bucket)
        except ClientError as error:
            if error.response['Error']['Code'] not in ('404', 'NoSuchBucket', 'NotFound'):
                raise
            client.create_bucket(Bucket=bucket)
        print(f'Ready: {bucket}', flush=True)


if __name__ == '__main__':
    main()
