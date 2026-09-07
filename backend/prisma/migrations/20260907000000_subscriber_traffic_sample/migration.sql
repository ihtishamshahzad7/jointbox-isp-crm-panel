-- CreateTable
CREATE TABLE "subscriber_traffic_sample" (
    "id" BIGSERIAL NOT NULL,
    "subscriber_id" INTEGER NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "in_bytes" BIGINT NOT NULL DEFAULT 0,
    "out_bytes" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "subscriber_traffic_sample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subscriber_traffic_sample_subscriber_id_ts_idx" ON "subscriber_traffic_sample"("subscriber_id", "ts");

-- AddForeignKey
ALTER TABLE "subscriber_traffic_sample" ADD CONSTRAINT "subscriber_traffic_sample_subscriber_id_fkey" FOREIGN KEY ("subscriber_id") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;