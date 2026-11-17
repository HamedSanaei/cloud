# Reproduce native brand assets on Windows. No remote images or fonts are used.
Add-Type -AssemblyName System.Drawing
function Draw-Brand($g, [int]$x, [int]$y, [int]$size) {
  $blue = New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml('#2869e8'))
  $white = New-Object Drawing.SolidBrush ([Drawing.Color]::White)
  $path = New-Object Drawing.Drawing2D.GraphicsPath
  $r = [int]($size * .45)
  $path.AddArc($x, $y, $r, $r, 180, 90)
  $path.AddArc($x+$size-$r, $y, $r, $r, 270, 90)
  $path.AddArc($x+$size-$r, $y+$size-$r, $r, $r, 0, 90)
  $path.AddArc($x, $y+$size-$r, $r, $r, 90, 90)
  $path.CloseFigure(); $g.FillPath($blue,$path)
  for ($i=0; $i -lt 3; $i++) { $g.FillRectangle($white, [int]($x+$size*.22), [int]($y+$size*(.25+$i*.2)), [int]($size*.56), [int]($size*.11)) }
  $path.Dispose(); $blue.Dispose(); $white.Dispose()
}
$icon = New-Object Drawing.Bitmap 192,192
$g = [Drawing.Graphics]::FromImage($icon); $g.SmoothingMode = 'AntiAlias'; $g.Clear([Drawing.Color]::Transparent)
Draw-Brand $g 0 0 192
$icon.Save((Join-Path $PWD 'public/favicon.png'), [Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $icon.Dispose()
$img = New-Object Drawing.Bitmap 1200,630
$g = [Drawing.Graphics]::FromImage($img); $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
$g.Clear([Drawing.ColorTranslator]::FromHtml('#0b1630'))
Draw-Brand $g 1000 66 112
$white = New-Object Drawing.SolidBrush ([Drawing.Color]::White)
$muted = New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml('#c6dcff'))
$font = New-Object Drawing.Font 'Tahoma',48,([Drawing.FontStyle]::Bold),([Drawing.GraphicsUnit]::Pixel)
$subfont = New-Object Drawing.Font 'Tahoma',34,([Drawing.FontStyle]::Regular),([Drawing.GraphicsUnit]::Pixel)
$rtl = New-Object Drawing.StringFormat; $rtl.FormatFlags = [Drawing.StringFormatFlags]::DirectionRightToLeft
$g.DrawString('پارس سرور',$font,$white,([Drawing.RectangleF]::new(80,85,870,90)),$rtl)
$g.DrawString('سرور ابری، انتخاب روشن',$font,$white,([Drawing.RectangleF]::new(80,260,1030,100)),$rtl)
$g.DrawString('مقایسه منابع و قیمت سرور',$subfont,$muted,([Drawing.RectangleF]::new(80,365,1030,90)),$rtl)
$g.DrawString('parserver.ir',$subfont,$muted,([Drawing.PointF]::new(80,520)))
$img.Save((Join-Path $PWD 'public/parserver-share.png'),[Drawing.Imaging.ImageFormat]::Png)
$rtl.Dispose();$font.Dispose();$subfont.Dispose();$white.Dispose();$muted.Dispose();$g.Dispose();$img.Dispose()
