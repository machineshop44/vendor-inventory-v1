-- Vendor Inventory v1
-- Ask the Decom SQL admin to create an empty database named VendorInventory
-- on the SQL Server the team already uses, then run this script inside it.
-- This script does not create a new SQL Server.

CREATE TABLE dbo.Sites (
  Id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Sites PRIMARY KEY,
  Name NVARCHAR(60) NOT NULL,
  CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_Sites_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_Sites_Name UNIQUE (Name)
);

CREATE TABLE dbo.Items (
  Id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Items PRIMARY KEY,
  Barcode NVARCHAR(64) NOT NULL,
  Description NVARCHAR(200) NOT NULL,
  Model NVARCHAR(80) NOT NULL CONSTRAINT DF_Items_Model DEFAULT N'',
  Vendor NVARCHAR(120) NOT NULL,
  Unit NVARCHAR(40) NOT NULL CONSTRAINT DF_Items_Unit DEFAULT N'each',
  CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_Items_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_Items_Barcode UNIQUE (Barcode)
);

CREATE TABLE dbo.Movements (
  Id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Movements PRIMARY KEY,
  SiteId INT NOT NULL CONSTRAINT FK_Movements_Sites REFERENCES dbo.Sites (Id),
  ItemId INT NOT NULL CONSTRAINT FK_Movements_Items REFERENCES dbo.Items (Id),
  Direction NVARCHAR(3) NOT NULL,
  Qty INT NOT NULL,
  ScannedAt DATETIME2 NOT NULL CONSTRAINT DF_Movements_ScannedAt DEFAULT SYSUTCDATETIME(),
  Ticket NVARCHAR(40) NOT NULL CONSTRAINT DF_Movements_Ticket DEFAULT N'',
  CONSTRAINT CK_Movements_Direction CHECK (Direction IN (N'in', N'out')),
  CONSTRAINT CK_Movements_Qty CHECK (Qty > 0)
);

CREATE INDEX IX_Movements_Site_Item ON dbo.Movements (SiteId, ItemId);
CREATE INDEX IX_Movements_ScannedAt ON dbo.Movements (ScannedAt);

CREATE VIEW dbo.OnHand AS
SELECT
  s.Id AS SiteId,
  s.Name AS SiteName,
  i.Id AS ItemId,
  i.Barcode,
  i.Description,
  i.Model,
  i.Vendor,
  i.Unit,
  SUM(CASE m.Direction WHEN N'in' THEN m.Qty ELSE -m.Qty END) AS OnHand
FROM dbo.Movements AS m
JOIN dbo.Sites AS s ON s.Id = m.SiteId
JOIN dbo.Items AS i ON i.Id = m.ItemId
GROUP BY s.Id, s.Name, i.Id, i.Barcode, i.Description, i.Model, i.Vendor, i.Unit;
