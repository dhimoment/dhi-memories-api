-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "driveLink" TEXT NOT NULL,
    "pin" TEXT NOT NULL,
    "maxPhotos" INTEGER NOT NULL DEFAULT 20,
    "waNumber" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_pin_key" ON "Project"("pin");
