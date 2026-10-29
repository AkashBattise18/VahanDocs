const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

// Increase JSON body limit to support base64 document images
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cors());

// Create uploads directory if not exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Serve uploaded document images statically
app.use('/uploads', express.static(uploadsDir));

// MySQL Database Connection Pool (Supports Environment Variables or Fallback)
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '1234',
    database: process.env.DB_NAME || 'vahandocs_db',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Verify DB Connection and Ensure schema
db.getConnection((err, conn) => {
    if (err) {
        console.error('Database connection failed: ' + err.stack);
        return;
    }
    console.log('Connected to MySQL Database successfully!');

    // Ensure tables and columns exist
    const createVehiclesTable = `
        CREATE TABLE IF NOT EXISTS vehicles (
            id INT AUTO_INCREMENT PRIMARY KEY,
            vehicle_number VARCHAR(100) NOT NULL,
            vehicle_type VARCHAR(100) NOT NULL,
            puc_expiry DATE NULL,
            insurance_expiry DATE NULL,
            passing_expiry DATE NULL,
            expiry_date DATE NULL,
            document_image VARCHAR(255) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `;

    const createUsersTable = `
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(100) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `;

    const createNotificationsTable = `
        CREATE TABLE IF NOT EXISTS notifications (
            id INT AUTO_INCREMENT PRIMARY KEY,
            vehicle_id INT NULL,
            vehicle_number VARCHAR(100) NULL,
            title VARCHAR(255) NOT NULL,
            message TEXT NOT NULL,
            type VARCHAR(50) DEFAULT 'warning',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `;

    conn.query(createUsersTable, () => {});
    conn.query(createVehiclesTable, () => {
        conn.query('ALTER TABLE vehicles MODIFY puc_expiry DATE NULL, MODIFY insurance_expiry DATE NULL, MODIFY passing_expiry DATE NULL', () => {});
    });
    conn.query(createNotificationsTable, () => {});
    conn.release();
});

// Helper: Calculate document expiry countdown in days
function getDaysRemaining(dateStr) {
    if (!dateStr) return null;
    const targetDate = new Date(dateStr);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    targetDate.setHours(0, 0, 0, 0);
    const diffTime = targetDate - today;
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// Helper: Get vehicle overall status
function calculateVehicleStatus(puc, ins, passing, generalExpiry) {
    const dates = [puc, ins, passing, generalExpiry].filter(Boolean).map(d => getDaysRemaining(d));
    if (dates.length === 0) return 'Active';
    const minDays = Math.min(...dates);
    if (minDays < 0) return 'Expired';
    if (minDays <= 30) return 'Expiring Soon';
    return 'Active';
}

// ------------------- API ROUTES ------------------- //

// Health Check
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'VahanDocs Backend is running' });
});

// 1. API Endpoint: Save User
app.post('/api/user', (req, res) => {
    const { username } = req.body;
    if (!username || username.trim() === '') {
        return res.status(400).json({ error: 'Username is required' });
    }

    const query = 'INSERT INTO users (username) VALUES (?)';
    db.query(query, [username.trim()], (err, result) => {
        if (err) {
            console.error('Error saving user:', err);
            return res.status(500).json({ error: 'Database error while saving user', details: err.message });
        }
        res.status(201).json({
            success: true,
            message: 'User saved successfully!',
            userId: result.insertId,
            username: username.trim()
        });
    });
});

// 2. API Endpoint: Get latest registered user
app.get('/api/user/latest', (req, res) => {
    const query = 'SELECT * FROM users ORDER BY id DESC LIMIT 1';
    db.query(query, (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (results.length === 0) {
            return res.status(404).json({ error: 'No user found' });
        }
        res.json({ success: true, user: results[0] });
    });
});

// 3. API Endpoint: Save Vehicle
app.post('/api/vehicle', (req, res) => {
    let {
        vehicle_number,
        vehicle_type,
        puc_expiry,
        insurance_expiry,
        passing_expiry,
        expiry_date,
        document_image,
        document_type
    } = req.body;

    if (!vehicle_number || !vehicle_type) {
        return res.status(400).json({ error: 'Vehicle number and vehicle type are required' });
    }

    vehicle_number = vehicle_number.toUpperCase().trim();

    if (expiry_date && (!puc_expiry && !insurance_expiry && !passing_expiry)) {
        if (document_type === 'Insurance') {
            insurance_expiry = expiry_date;
        } else if (document_type === 'Passing' || document_type === 'Fitness') {
            passing_expiry = expiry_date;
        } else {
            puc_expiry = expiry_date;
        }
    }

    let savedImagePath = null;
    if (document_image && document_image.startsWith('data:image')) {
        try {
            const matches = document_image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                const ext = matches[1].split('/')[1] || 'jpg';
                const base64Data = matches[2];
                const cleanNumber = vehicle_number.replace(/[^a-zA-Z0-9]/g, '_');
                const filename = `doc_${cleanNumber}_${Date.now()}.${ext}`;
                const fullFilePath = path.join(uploadsDir, filename);

                fs.writeFileSync(fullFilePath, Buffer.from(base64Data, 'base64'));
                savedImagePath = `/uploads/${filename}`;
            }
        } catch (imgErr) {
            console.error('Error saving document image file:', imgErr);
        }
    } else if (document_image) {
        savedImagePath = document_image;
    }

    const primaryExpiry = expiry_date || puc_expiry || insurance_expiry || passing_expiry || null;

    const query = `
        INSERT INTO vehicles 
        (vehicle_number, vehicle_type, puc_expiry, insurance_expiry, passing_expiry, expiry_date, document_image) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(
        query,
        [
            vehicle_number,
            vehicle_type,
            puc_expiry || null,
            insurance_expiry || null,
            passing_expiry || null,
            primaryExpiry,
            savedImagePath
        ],
        (err, result) => {
            if (err) {
                console.error('Database error inserting vehicle:', err);
                return res.status(500).json({ error: 'Failed to save vehicle details', details: err.message });
            }

            const vehicleId = result.insertId;

            const checkAndCreateAlert = (docName, dateVal) => {
                if (!dateVal) return;
                const days = getDaysRemaining(dateVal);
                if (days !== null && days <= 30) {
                    const alertType = days < 0 ? 'danger' : 'warning';
                    const title = days < 0 ? `${docName} Expired!` : `${docName} Expiring Soon!`;
                    const msg = days < 0
                        ? `${docName} for vehicle ${vehicle_number} expired ${Math.abs(days)} day(s) ago! Immediate renewal required.`
                        : `${docName} for vehicle ${vehicle_number} will expire in ${days} day(s) on ${dateVal}.`;

                    db.query(
                        'INSERT INTO notifications (vehicle_id, vehicle_number, title, message, type) VALUES (?, ?, ?, ?, ?)',
                        [vehicleId, vehicle_number, title, msg, alertType],
                        () => {}
                    );
                }
            };

            checkAndCreateAlert('PUC', puc_expiry);
            checkAndCreateAlert('Insurance', insurance_expiry);
            checkAndCreateAlert('Passing', passing_expiry);

            db.query(
                'INSERT INTO notifications (vehicle_id, vehicle_number, title, message, type) VALUES (?, ?, ?, ?, ?)',
                [
                    vehicleId,
                    vehicle_number,
                    'Vehicle Registered',
                    `Vehicle ${vehicle_number} (${vehicle_type}) was successfully added with smart tracking enabled.`,
                    'info'
                ],
                () => {}
            );

            res.status(201).json({
                success: true,
                message: 'Vehicle and documents saved successfully!',
                vehicleId: vehicleId,
                document_path: savedImagePath,
                vehicle: {
                    id: vehicleId,
                    vehicle_number,
                    vehicle_type,
                    puc_expiry,
                    insurance_expiry,
                    passing_expiry,
                    expiry_date: primaryExpiry,
                    document_image: savedImagePath
                }
            });
        }
    );
});

// 4. API Endpoint: Fetch All Registered Vehicles with Live Status
app.get('/api/vehicles', (req, res) => {
    const query = 'SELECT * FROM vehicles ORDER BY id DESC';
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error fetching vehicles:', err);
            return res.status(500).json({ error: 'Failed to fetch vehicles', details: err.message });
        }

        const vehicles = results.map(v => {
            const status = calculateVehicleStatus(v.puc_expiry, v.insurance_expiry, v.passing_expiry, v.expiry_date);
            return {
                ...v,
                status,
                puc_days: getDaysRemaining(v.puc_expiry),
                insurance_days: getDaysRemaining(v.insurance_expiry),
                passing_days: getDaysRemaining(v.passing_expiry),
                general_days: getDaysRemaining(v.expiry_date)
            };
        });

        res.json({
            success: true,
            count: vehicles.length,
            vehicles
        });
    });
});

// 5. API Endpoint: Fetch Saved Fleet Documents with Live Countdown
app.get('/api/documents', (req, res) => {
    const query = 'SELECT id, vehicle_number, vehicle_type, puc_expiry, insurance_expiry, passing_expiry, expiry_date, document_image, created_at FROM vehicles ORDER BY id DESC';
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error fetching fleet documents:', err);
            return res.status(500).json({ error: 'Failed to fetch documents', details: err.message });
        }

        const documents = [];

        results.forEach(v => {
            const docTypes = [
                { type: 'PUC Certificate', date: v.puc_expiry },
                { type: 'Vehicle Insurance', date: v.insurance_expiry },
                { type: 'Fitness / Passing', date: v.passing_expiry },
                { type: 'Registration / Document', date: v.expiry_date }
            ];

            let hasAdded = false;
            docTypes.forEach(doc => {
                if (doc.date) {
                    const daysRemaining = getDaysRemaining(doc.date);
                    let status = 'Active';
                    if (daysRemaining < 0) status = 'Expired';
                    else if (daysRemaining <= 30) status = 'Expiring Soon';

                    documents.push({
                        vehicle_id: v.id,
                        vehicle_number: v.vehicle_number,
                        vehicle_type: v.vehicle_type,
                        document_type: doc.type,
                        expiry_date: doc.date,
                        days_remaining: daysRemaining,
                        status: status,
                        document_image: v.document_image,
                        created_at: v.created_at
                    });
                    hasAdded = true;
                }
            });

            if (!hasAdded && v.document_image) {
                documents.push({
                    vehicle_id: v.id,
                    vehicle_number: v.vehicle_number,
                    vehicle_type: v.vehicle_type,
                    document_type: 'Fleet Document',
                    expiry_date: null,
                    days_remaining: null,
                    status: 'Active',
                    document_image: v.document_image,
                    created_at: v.created_at
                });
            }
        });

        res.json({
            success: true,
            count: documents.length,
            documents
        });
    });
});

// 6. API Endpoint: Fetch Notifications History
app.get('/api/notifications', (req, res) => {
    const query = 'SELECT * FROM notifications ORDER BY id DESC LIMIT 50';
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error fetching notifications:', err);
            return res.status(500).json({ error: 'Failed to fetch notifications', details: err.message });
        }
        res.json({
            success: true,
            count: results.length,
            notifications: results
        });
    });
});

// 7. API Endpoint: Post a new notification
app.post('/api/notifications', (req, res) => {
    const { vehicle_id, vehicle_number, title, message, type } = req.body;
    if (!title || !message) {
        return res.status(400).json({ error: 'Title and message are required' });
    }

    const query = 'INSERT INTO notifications (vehicle_id, vehicle_number, title, message, type) VALUES (?, ?, ?, ?, ?)';
    db.query(query, [vehicle_id || null, vehicle_number || null, title, message, type || 'warning'], (err, result) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.status(201).json({ success: true, message: 'Notification created', notificationId: result.insertId });
    });
});

// 8. API Endpoint: Delete single notification
app.delete('/api/notifications/:id', (req, res) => {
    const id = req.params.id;
    db.query('DELETE FROM notifications WHERE id = ?', [id], (err, result) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Notification not found' });
        }
        res.json({ success: true, message: 'Notification deleted successfully' });
    });
});

// 9. API Endpoint: Clear all notifications
app.delete('/api/notifications', (req, res) => {
    db.query('DELETE FROM notifications', (err) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, message: 'All notifications cleared' });
    });
});

// 10. API Endpoint: Delete Vehicle
app.delete('/api/vehicle/:id', (req, res) => {
    const id = req.params.id;
    db.query('DELETE FROM vehicles WHERE id = ?', [id], (err, result) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, message: 'Vehicle deleted successfully' });
    });
});

// Server Start (Render automatically assigns PORT via process.env.PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`VahanDocs Server is running on port ${PORT}`);
});