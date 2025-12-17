/*
 Navicat Premium Dump SQL

 Source Server         : 43.134.27.182
 Source Server Type    : PostgreSQL
 Source Server Version : 160003 (160003)
 Source Host           : 43.134.27.182:43562
 Source Catalog        : test1
 Source Schema         : public

 Target Server Type    : PostgreSQL
 Target Server Version : 160003 (160003)
 File Encoding         : 65001

 Date: 07/11/2025 00:05:14
*/


-- ----------------------------
-- Sequence structure for activity_snapshots_id_seq
-- ----------------------------
DROP SEQUENCE IF EXISTS "public"."activity_snapshots_id_seq";
CREATE SEQUENCE "public"."activity_snapshots_id_seq" 
INCREMENT 1
MINVALUE  1
MAXVALUE 2147483647
START 1
CACHE 1;

-- ----------------------------
-- Sequence structure for organizations_id_seq
-- ----------------------------
DROP SEQUENCE IF EXISTS "public"."organizations_id_seq";
CREATE SEQUENCE "public"."organizations_id_seq" 
INCREMENT 1
MINVALUE  1
MAXVALUE 2147483647
START 1
CACHE 1;

-- ----------------------------
-- Sequence structure for repo_snapshots_id_seq
-- ----------------------------
DROP SEQUENCE IF EXISTS "public"."repo_snapshots_id_seq";
CREATE SEQUENCE "public"."repo_snapshots_id_seq" 
INCREMENT 1
MINVALUE  1
MAXVALUE 2147483647
START 1
CACHE 1;

-- ----------------------------
-- Sequence structure for repositories_id_seq
-- ----------------------------
DROP SEQUENCE IF EXISTS "public"."repositories_id_seq";
CREATE SEQUENCE "public"."repositories_id_seq" 
INCREMENT 1
MINVALUE  1
MAXVALUE 2147483647
START 1
CACHE 1;

-- ----------------------------
-- Sequence structure for sig_snapshots_id_seq
-- ----------------------------
DROP SEQUENCE IF EXISTS "public"."sig_snapshots_id_seq";
CREATE SEQUENCE "public"."sig_snapshots_id_seq" 
INCREMENT 1
MINVALUE  1
MAXVALUE 2147483647
START 1
CACHE 1;

-- ----------------------------
-- Sequence structure for special_interest_groups_id_seq
-- ----------------------------
DROP SEQUENCE IF EXISTS "public"."special_interest_groups_id_seq";
CREATE SEQUENCE "public"."special_interest_groups_id_seq" 
INCREMENT 1
MINVALUE  1
MAXVALUE 2147483647
START 1
CACHE 1;

-- ----------------------------
-- Table structure for activity_snapshots
-- ----------------------------
DROP TABLE IF EXISTS "public"."activity_snapshots";
CREATE TABLE "public"."activity_snapshots" (
  "id" int4 NOT NULL DEFAULT nextval('activity_snapshots_id_seq'::regclass),
  "org_id" int4 NOT NULL,
  "snapshot_date" date NOT NULL,
  "new_prs" int4 DEFAULT 0,
  "closed_merged_prs" int4 DEFAULT 0,
  "new_issues" int4 DEFAULT 0,
  "closed_issues" int4 DEFAULT 0,
  "active_contributors" int4 DEFAULT 0,
  "new_repos" int4 DEFAULT 0,
  "new_commits" int4 DEFAULT 0,
  "lines_added" int4 DEFAULT 0,
  "lines_deleted" int4 DEFAULT 0,
  "created_at" timestamptz(6) DEFAULT now()
)
;

-- ----------------------------
-- Table structure for organizations
-- ----------------------------
DROP TABLE IF EXISTS "public"."organizations";
CREATE TABLE "public"."organizations" (
  "id" int4 NOT NULL DEFAULT nextval('organizations_id_seq'::regclass),
  "name" varchar(255) COLLATE "pg_catalog"."default" NOT NULL,
  "created_at" timestamptz(6) DEFAULT now()
)
;

-- ----------------------------
-- Records of organizations
-- ----------------------------
INSERT INTO "public"."organizations" VALUES (1, 'hust-open-atom-club', '2025-11-05 15:05:49.354464+00');

-- ----------------------------
-- Table structure for repo_snapshots
-- ----------------------------
DROP TABLE IF EXISTS "public"."repo_snapshots";
CREATE TABLE "public"."repo_snapshots" (
  "id" int4 NOT NULL DEFAULT nextval('repo_snapshots_id_seq'::regclass),
  "repo_id" int4 NOT NULL,
  "snapshot_date" date NOT NULL,
  "new_prs" int4 DEFAULT 0,
  "closed_merged_prs" int4 DEFAULT 0,
  "new_issues" int4 DEFAULT 0,
  "closed_issues" int4 DEFAULT 0,
  "active_contributors" int4 DEFAULT 0,
  "new_commits" int4 DEFAULT 0,
  "lines_added" int4 DEFAULT 0,
  "lines_deleted" int4 DEFAULT 0,
  "created_at" timestamptz(6) DEFAULT now()
)
;


-- ----------------------------
-- Table structure for repositories
-- ----------------------------
DROP TABLE IF EXISTS "public"."repositories";
CREATE TABLE "public"."repositories" (
  "id" int4 NOT NULL DEFAULT nextval('repositories_id_seq'::regclass),
  "org_id" int4 NOT NULL,
  "sig_id" int4 NOT NULL,
  "name" varchar(255) COLLATE "pg_catalog"."default" NOT NULL,
  "description" text COLLATE "pg_catalog"."default",
  "created_at" timestamptz(6) DEFAULT now()
)
;

-- ----------------------------
-- Table structure for sig_snapshots
-- ----------------------------
DROP TABLE IF EXISTS "public"."sig_snapshots";
CREATE TABLE "public"."sig_snapshots" (
  "id" int4 NOT NULL DEFAULT nextval('sig_snapshots_id_seq'::regclass),
  "sig_id" int4 NOT NULL,
  "snapshot_date" date NOT NULL,
  "new_prs" int4 DEFAULT 0,
  "closed_merged_prs" int4 DEFAULT 0,
  "new_issues" int4 DEFAULT 0,
  "closed_issues" int4 DEFAULT 0,
  "active_contributors" int4 DEFAULT 0,
  "new_commits" int4 DEFAULT 0,
  "lines_added" int4 DEFAULT 0,
  "lines_deleted" int4 DEFAULT 0,
  "created_at" timestamptz(6) DEFAULT now()
)
;
-- ----------------------------
-- Table structure for special_interest_groups
-- ----------------------------
DROP TABLE IF EXISTS "public"."special_interest_groups";
CREATE TABLE "public"."special_interest_groups" (
  "id" int4 NOT NULL DEFAULT nextval('special_interest_groups_id_seq'::regclass),
  "org_id" int4 NOT NULL,
  "name" varchar(255) COLLATE "pg_catalog"."default" NOT NULL,
  "created_at" timestamptz(6) DEFAULT now()
)
;

-- ----------------------------
-- Alter sequences owned by
-- ----------------------------
ALTER SEQUENCE "public"."activity_snapshots_id_seq"
OWNED BY "public"."activity_snapshots"."id";
SELECT setval('"public"."activity_snapshots_id_seq"', 107, true);

-- ----------------------------
-- Alter sequences owned by
-- ----------------------------
ALTER SEQUENCE "public"."organizations_id_seq"
OWNED BY "public"."organizations"."id";
SELECT setval('"public"."organizations_id_seq"', 1, true);

-- ----------------------------
-- Alter sequences owned by
-- ----------------------------
ALTER SEQUENCE "public"."repo_snapshots_id_seq"
OWNED BY "public"."repo_snapshots"."id";
SELECT setval('"public"."repo_snapshots_id_seq"', 12442, true);

-- ----------------------------
-- Alter sequences owned by
-- ----------------------------
ALTER SEQUENCE "public"."repositories_id_seq"
OWNED BY "public"."repositories"."id";
SELECT setval('"public"."repositories_id_seq"', 70, true);

-- ----------------------------
-- Alter sequences owned by
-- ----------------------------
ALTER SEQUENCE "public"."sig_snapshots_id_seq"
OWNED BY "public"."sig_snapshots"."id";
SELECT setval('"public"."sig_snapshots_id_seq"', 642, true);

-- ----------------------------
-- Alter sequences owned by
-- ----------------------------
ALTER SEQUENCE "public"."special_interest_groups_id_seq"
OWNED BY "public"."special_interest_groups"."id";
SELECT setval('"public"."special_interest_groups_id_seq"', 6, true);

-- ----------------------------
-- Indexes structure for table activity_snapshots
-- ----------------------------
CREATE INDEX "idx_activity_snapshots_org_date" ON "public"."activity_snapshots" USING btree (
  "org_id" "pg_catalog"."int4_ops" ASC NULLS LAST,
  "snapshot_date" "pg_catalog"."date_ops" ASC NULLS LAST
);

-- ----------------------------
-- Uniques structure for table activity_snapshots
-- ----------------------------
ALTER TABLE "public"."activity_snapshots" ADD CONSTRAINT "activity_snapshots_org_id_snapshot_date_key" UNIQUE ("org_id", "snapshot_date");

-- ----------------------------
-- Primary Key structure for table activity_snapshots
-- ----------------------------
ALTER TABLE "public"."activity_snapshots" ADD CONSTRAINT "activity_snapshots_pkey" PRIMARY KEY ("id");

-- ----------------------------
-- Uniques structure for table organizations
-- ----------------------------
ALTER TABLE "public"."organizations" ADD CONSTRAINT "organizations_name_key" UNIQUE ("name");

-- ----------------------------
-- Primary Key structure for table organizations
-- ----------------------------
ALTER TABLE "public"."organizations" ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");

-- ----------------------------
-- Indexes structure for table repo_snapshots
-- ----------------------------
CREATE INDEX "idx_repo_snapshots_repo_date" ON "public"."repo_snapshots" USING btree (
  "repo_id" "pg_catalog"."int4_ops" ASC NULLS LAST,
  "snapshot_date" "pg_catalog"."date_ops" ASC NULLS LAST
);

-- ----------------------------
-- Uniques structure for table repo_snapshots
-- ----------------------------
ALTER TABLE "public"."repo_snapshots" ADD CONSTRAINT "repo_snapshots_repo_id_snapshot_date_key" UNIQUE ("repo_id", "snapshot_date");

-- ----------------------------
-- Primary Key structure for table repo_snapshots
-- ----------------------------
ALTER TABLE "public"."repo_snapshots" ADD CONSTRAINT "repo_snapshots_pkey" PRIMARY KEY ("id");

-- ----------------------------
-- Uniques structure for table repositories
-- ----------------------------
ALTER TABLE "public"."repositories" ADD CONSTRAINT "repositories_org_id_name_key" UNIQUE ("org_id", "name");

-- ----------------------------
-- Primary Key structure for table repositories
-- ----------------------------
ALTER TABLE "public"."repositories" ADD CONSTRAINT "repositories_pkey" PRIMARY KEY ("id");

-- ----------------------------
-- Indexes structure for table sig_snapshots
-- ----------------------------
CREATE INDEX "idx_sig_snapshots_sig_date" ON "public"."sig_snapshots" USING btree (
  "sig_id" "pg_catalog"."int4_ops" ASC NULLS LAST,
  "snapshot_date" "pg_catalog"."date_ops" ASC NULLS LAST
);

-- ----------------------------
-- Uniques structure for table sig_snapshots
-- ----------------------------
ALTER TABLE "public"."sig_snapshots" ADD CONSTRAINT "sig_snapshots_sig_id_snapshot_date_key" UNIQUE ("sig_id", "snapshot_date");

-- ----------------------------
-- Primary Key structure for table sig_snapshots
-- ----------------------------
ALTER TABLE "public"."sig_snapshots" ADD CONSTRAINT "sig_snapshots_pkey" PRIMARY KEY ("id");

-- ----------------------------
-- Uniques structure for table special_interest_groups
-- ----------------------------
ALTER TABLE "public"."special_interest_groups" ADD CONSTRAINT "special_interest_groups_org_id_name_key" UNIQUE ("org_id", "name");

-- ----------------------------
-- Primary Key structure for table special_interest_groups
-- ----------------------------
ALTER TABLE "public"."special_interest_groups" ADD CONSTRAINT "special_interest_groups_pkey" PRIMARY KEY ("id");

-- ----------------------------
-- Foreign Keys structure for table activity_snapshots
-- ----------------------------
ALTER TABLE "public"."activity_snapshots" ADD CONSTRAINT "activity_snapshots_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ----------------------------
-- Foreign Keys structure for table repo_snapshots
-- ----------------------------
ALTER TABLE "public"."repo_snapshots" ADD CONSTRAINT "repo_snapshots_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ----------------------------
-- Foreign Keys structure for table repositories
-- ----------------------------
ALTER TABLE "public"."repositories" ADD CONSTRAINT "repositories_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "public"."repositories" ADD CONSTRAINT "repositories_sig_id_fkey" FOREIGN KEY ("sig_id") REFERENCES "public"."special_interest_groups" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ----------------------------
-- Foreign Keys structure for table sig_snapshots
-- ----------------------------
ALTER TABLE "public"."sig_snapshots" ADD CONSTRAINT "sig_snapshots_sig_id_fkey" FOREIGN KEY ("sig_id") REFERENCES "public"."special_interest_groups" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ----------------------------
-- Foreign Keys structure for table special_interest_groups
-- ----------------------------
ALTER TABLE "public"."special_interest_groups" ADD CONSTRAINT "special_interest_groups_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
