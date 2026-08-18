-- Il ponte di sessione del guscio (login nel browser di sistema, codice monouso)
CREATE TABLE "PonteSessione" (
    "codice" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "claims" JSONB NOT NULL,
    "scade" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PonteSessione_pkey" PRIMARY KEY ("codice")
);
