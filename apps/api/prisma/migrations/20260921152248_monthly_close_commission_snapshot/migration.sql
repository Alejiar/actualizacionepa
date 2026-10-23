-- AlterTable
ALTER TABLE "MonthlyClose" ADD COLUMN     "commissionPending" INTEGER,
ADD COLUMN     "commissionSnapshot" JSONB;
