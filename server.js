const express = require("express");
const axios = require("axios");
const PDFParser = require("pdf-parse");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

// Store processing jobs in memory (in production, use Redis or database)
const jobs = new Map();

// Main endpoint to process PDFs
app.post("/api/process-pdfs", async (req, res) => {
  console.log("POST /api/process-pdfs called with:", req.body);
  const { university, major, course } = req.body;

  if (!university || !major || !course) {
    return res.status(400).json({
      error: "University, major, and course are required",
    });
  }

  const jobId = generateJobId();

  // Start processing asynchronously
  processUniversityPDFs(jobId, university, major, course);

  res.json({
    jobId,
    status: "processing",
    message: "PDF processing started",
  });
});

// Check job status
app.get("/api/jobs/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  console.log(job);
  res.json(job);
});

// Main processing function (equivalent to your grabPDFs + courseList)
async function processUniversityPDFs(jobId, university, major, course) {
  try {
    // Update job status
    jobs.set(jobId, {
      status: "processing",
      progress: "Fetching institutions...",
      applicableColleges: [],
      error: null,
    });

    // Get institutions list
    const institutionsResponse = await axios.get(
      "https://assist.org/api/institutions"
    );
    const institutions = institutionsResponse.data;

    // Find target university ID
    let universityId = null;
    for (const institution of institutions) {
      const collegeName = institution.names[0].name;
      if (collegeName === university) {
        universityId = institution.id;
        break;
      }
    }

    if (!universityId) {
      throw new Error(`University "${university}" not found`);
    }

    // Update progress
    updateJobProgress(jobId, "Fetching agreements...");

    // Get institution agreements
    const agreementsResponse = await axios.get(
      `https://assist.org/api/institutions/${universityId}/agreements`
    );
    const agreementData = agreementsResponse.data;

    // Extract college IDs that have agreements
    const collegeIds = agreementData.map((entry) => entry.institutionParentId);

    updateJobProgress(jobId, `Processing ${collegeIds.length} colleges...`);

    const applicableColleges = [];
    let processedCount = 0;

    // Process each college
    for (const collegeId of collegeIds) {
      try {
        const majorUrl = `https://assist.org/api/agreements?receivingInstitutionId=${universityId}&sendingInstitutionId=${collegeId}&academicYearId=72&categoryCode=major`;
        const majorResponse = await axios.get(majorUrl);
        const majorData = majorResponse.data;

        // Find matching major
        for (const majorEntry of majorData.reports || []) {
          if (majorEntry.label === major) {
            const key = majorEntry.key;
            const downloadUrl = `https://assist.org/api/artifacts/${key}`;

            // Download PDF into memory
            const pdfResponse = await axios.get(downloadUrl, {
              responseType: "arraybuffer",
            });

            if (pdfResponse.status === 200) {
              // Process PDF from memory buffer and check for course articulation
              const pdfBuffer = Buffer.from(pdfResponse.data);
              const courseCheck = await checkCourseArticulation(
                pdfBuffer,
                course,
                key
              );
              // If course is articulated, add to applicable colleges list
              if (courseCheck.isArticulated && courseCheck.college) {
                applicableColleges.push(courseCheck.college);
                console.log(courseCheck.college);
              }
            }

            break; // Found the major, move to next college
          }
        }
      } catch (error) {
        console.error(`Error processing college ${collegeId}:`, error.message);
        // Continue with other colleges
      }

      processedCount++;
      updateJobProgress(
        jobId,
        `Processed ${processedCount}/${collegeIds.length} colleges`
      );
    }

    // Job completed successfully
    jobs.set(jobId, {
      status: "completed",
      progress: "Done",
      applicableColleges,
      error: null,
      totalProcessed: processedCount,
      articulatedCount: applicableColleges.length,
      summary: `Found ${applicableColleges.length} colleges that articulate the course "${course}"`,
    });
  } catch (error) {
    console.error("Processing error:", error);
    jobs.set(jobId, {
      status: "failed",
      progress: "Failed",
      applicableColleges: [],
      error: error.message,
    });
  }
}

// Check if course is articulated (equivalent to isCourseArticulated function)
async function checkCourseArticulation(pdfBuffer, course, key) {
  try {
    // Parse PDF content from buffer
    const data = await PDFParser(pdfBuffer);

    // Clean course name (remove unrendered characters)
    const cleanCourse = course.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");

    // Clean PDF text (remove unrendered characters)
    const cleanText = data.text.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");

    let college = "";

    // Extract college name from "From:" line
    const fromIndex = cleanText.indexOf("From:");
    if (fromIndex !== -1) {
      const afterFrom = cleanText.substring(fromIndex + 6);
      const yearIndex = afterFrom.indexOf("2"); // Look for year like "2021-2022"
      if (yearIndex !== -1) {
        college = afterFrom.substring(0, yearIndex - 1).trim();
      }
    }
    // console.log(college);
    // Search for the course in the text
    const searchPosition = cleanText.indexOf(cleanCourse);

    if (searchPosition !== -1) {
      // Look for arrow after the course
      const afterCourse = cleanText.substring(
        searchPosition + cleanCourse.length
      );
      const arrowIndex = afterCourse.indexOf("←");

      if (arrowIndex !== -1) {
        // Extract the articulated course info (30 chars after arrow)
        const articulatedSection = afterCourse.substring(
          arrowIndex,
          arrowIndex + 30
        );

        // Check if course is NOT articulated
        const notArticulated = [
          "No Course Articulated",
          "No Comparable Course",
          "Course(s) Denied",
        ];

        const isNotArticulated = notArticulated.some((phrase) =>
          articulatedSection.includes(phrase)
        );

        if (!isNotArticulated) {
          // Course IS articulated
          return {
            college: college,
            isArticulated: true,
            articulatedCourse: articulatedSection.trim(),
            key,
          };
        }
      }
    }
    // Course is not articulated or not found
    return {
      college: college,
      isArticulated: false,
      articulatedCourse: null,
      key,
    };
  } catch (error) {
    console.error(`Error checking course articulation for PDF ${key}:`, error);
    return {
      college: "",
      isArticulated: false,
      articulatedCourse: null,
      key,
      error: error.message,
    };
  }
}

// Helper functions
function generateJobId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function updateJobProgress(jobId, progress) {
  const job = jobs.get(jobId);
  if (job) {
    job.progress = progress;
    jobs.set(jobId, job);
  }
}

// Clean up old jobs (run every hour)
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [jobId, job] of jobs.entries()) {
    if (job.createdAt && job.createdAt < oneHourAgo) {
      jobs.delete(jobId);
    }
  }
}, 60 * 60 * 1000);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
