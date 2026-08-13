ALTER TABLE forge_companies ADD COLUMN issue_code TEXT;
--> statement-breakpoint
ALTER TABLE forge_companies ADD COLUMN next_issue_number INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE forge_tasks ADD COLUMN issue_number INTEGER;
--> statement-breakpoint
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY company_id ORDER BY created_at, id) AS issue_number
  FROM forge_tasks
)
UPDATE forge_tasks
SET issue_number = (SELECT ranked.issue_number FROM ranked WHERE ranked.id = forge_tasks.id);
--> statement-breakpoint
UPDATE forge_companies
SET next_issue_number = COALESCE((
  SELECT max(forge_tasks.issue_number) + 1
  FROM forge_tasks
  WHERE forge_tasks.company_id = forge_companies.id
), 1);
--> statement-breakpoint
CREATE UNIQUE INDEX forge_tasks_company_issue_number_unique
ON forge_tasks(company_id, issue_number)
WHERE issue_number IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER forge_tasks_assign_issue_number
AFTER INSERT ON forge_tasks
WHEN NEW.issue_number IS NULL
BEGIN
  UPDATE forge_tasks
  SET issue_number = (
    SELECT next_issue_number
    FROM forge_companies
    WHERE id = NEW.company_id
  )
  WHERE id = NEW.id;

  UPDATE forge_companies
  SET next_issue_number = next_issue_number + 1
  WHERE id = NEW.company_id;
END;
