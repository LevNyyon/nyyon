-- 0004 — seed tags for the 20 newest blog posts (the ones I have tag data for from /blog/).
-- Other 166 posts stay tags=NULL until populated via the editor or Nyo.

UPDATE blog_posts SET tags = '["AI Strategy"]'                                          WHERE slug = 'where-ai-actually-creates-business-value';
UPDATE blog_posts SET tags = '["Marketing Data","Martech"]'                              WHERE slug = 'the-marketing-data-spine';
UPDATE blog_posts SET tags = '["Data Visualization","Business Intelligence"]'            WHERE slug = 'stop-ranking-charts-start-picking-the-right-visualization-stack';
UPDATE blog_posts SET tags = '["Data","Optimization","Analytics"]'                       WHERE slug = 'the-fastest-data-is-the-data-you-never-process';
UPDATE blog_posts SET tags = '["Startup","Data","Product Analytics"]'                    WHERE slug = 'startup-data-stack-that-actually-drives-growth';
UPDATE blog_posts SET tags = '["Decision Velocity","AI Marketing"]'                      WHERE slug = 'decision-velocity-the-new-growth-advantage-for-ai-native-marketing-teams';
UPDATE blog_posts SET tags = '["Marketing Analytics","Agentic AI"]'                      WHERE slug = 'the-new-marketing-intelligence-stack';
UPDATE blog_posts SET tags = '["Business Intelligence","Marketing Analytics"]'           WHERE slug = 'marketing-leaders-field-guide-to-choosing-bi-that-drives-decisions';
UPDATE blog_posts SET tags = '["Marketing Measurement","Incrementality"]'                WHERE slug = 'roas-is-not-the-truth';
UPDATE blog_posts SET tags = '["Data Visualization","Marketing Analytics"]'              WHERE slug = 'from-dashboards-to-decisions-marketing-leaders-guide-data-visualization-tools';
UPDATE blog_posts SET tags = '["AI Strategy","Campaign Intelligence"]'                   WHERE slug = 'the-human-led-campaign-intelligence-playbook';
UPDATE blog_posts SET tags = '["AI Marketing","Marketing ROI"]'                          WHERE slug = 'from-roas-theater-to-profit-decisions';
UPDATE blog_posts SET tags = '["AI Marketing","Agency Operations"]'                      WHERE slug = 'the-lean-ai-marketing-stack-agencies-can-actually-profit-from';
UPDATE blog_posts SET tags = '["AI Marketing","Conversion Rate Optimization"]'           WHERE slug = 'the-ai-conversion-lift-playbook';
UPDATE blog_posts SET tags = '["AI Strategy","Marketing Analytics"]'                     WHERE slug = 'the-insight-engine-how-ai-turns-marketing-noise-into-better-decisions';
UPDATE blog_posts SET tags = '["AI Marketing","Marketing Systems"]'                      WHERE slug = 'the-last-mile-of-ai-marketing';
UPDATE blog_posts SET tags = '["AI Commerce","Ecommerce Strategy"]'                      WHERE slug = 'the-ai-commerce-advantage-product-data-checkout-lifecycle-systems';
UPDATE blog_posts SET tags = '["AI Marketing","Startup Growth"]'                         WHERE slug = 'affordable-ai-marketing-agencies-what-startups-should-really-pay-for';
UPDATE blog_posts SET tags = '["AI Marketing","Campaign Velocity"]'                      WHERE slug = 'from-ai-output-to-campaign-velocity';
UPDATE blog_posts SET tags = '["AI-native Agencies","Marketing Systems"]'                WHERE slug = 'ai-from-day-one-new-marketing-agency-model-leaders-should-watch';
