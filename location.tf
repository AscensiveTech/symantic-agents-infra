# Amazon Location Service - maps and place search for the Service Area
# editor, and the call-time coverage check (docs/service-areas.md).
#
# - The browser gets one API key, limited to map tiles/styles and to this
#   app's own pages. It's public by design (it ships in page requests), so
#   the restrictions are the protection.
# - Place search and lookups go through the BFF, signed with its role, so no
#   places-capable key ever reaches the browser.
# - The tools Lambda geocodes what the caller said.
#
# The AWS provider has no resource for Amazon Location API keys, so the key
# is managed through Cloud Control (CloudFormation's AWS::Location::APIKey).

locals {
  location_maps_key_name = "${local.name_prefix}-service-area-maps"
  location_maps_referers = distinct(compact([
    "${trimsuffix(local.app_url, "/")}/*",
    "https://${var.amplify_branch}.${aws_amplify_app.frontend.default_domain}/*",
    "http://localhost:3000/*",
  ]))
  location_places_arn = "arn:aws:geo-places:${data.aws_region.current.name}::provider/default"
  location_maps_arn   = "arn:aws:geo-maps:${data.aws_region.current.name}::provider/default"
}

resource "aws_cloudcontrolapi_resource" "location_maps_key" {
  type_name = "AWS::Location::APIKey"

  desired_state = jsonencode({
    KeyName     = local.location_maps_key_name
    Description = "Service Area editor map tiles (browser). Tiles and styles only, this app's pages only."
    NoExpiry    = true
    Restrictions = {
      AllowActions   = ["geo-maps:GetTile", "geo-maps:GetStaticMap"]
      AllowResources = [local.location_maps_arn]
      AllowReferers  = local.location_maps_referers
    }
  })
}

resource "aws_iam_role_policy" "bff_location" {
  name = "${local.name_prefix}-bff-location"
  role = aws_iam_role.bff_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ServiceAreaPlaceSearch"
        Effect = "Allow"
        Action = [
          "geo-places:Suggest",
          "geo-places:Autocomplete",
          "geo-places:GetPlace",
          "geo-places:ReverseGeocode",
        ]
        Resource = local.location_places_arn
      },
      {
        # The browser maps key's value, handed to signed-in users for map tiles.
        Sid      = "ReadMapsKey"
        Effect   = "Allow"
        Action   = ["geo:DescribeKey"]
        Resource = "arn:aws:geo:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:api-key/${local.location_maps_key_name}"
      },
    ]
  })
}

resource "aws_iam_role_policy" "tools_location" {
  name = "${local.name_prefix}-tools-location"
  role = aws_iam_role.tools_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "GeocodeCallerLocations"
      Effect   = "Allow"
      Action   = ["geo-places:Geocode"]
      Resource = local.location_places_arn
    }]
  })
}
